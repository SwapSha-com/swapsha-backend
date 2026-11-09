//! SwapSha (Phase 3, build step A5b): blocks the node has that ZeroMQ never
//! delivered.
//!
//! The sidecar learns about blocks only through the node's ZeroMQ `rawblock`
//! feed, and a block it never hears about is never looked at: a lockup that
//! confirmed in it stays unconfirmed for SwapSha until the swap expires. Seen
//! on testnet4 on Nov 9: the Start9 lost the Mac running the nodes for three
//! minutes, the dead block socket was only replaced after its 60 minute
//! inactivity timeout, and the block confirming a user's lockup arrived in
//! between. A dropped connection, a node restart or a lost message can do the
//! same on any network.
//!
//! This task asks the node for its tip once a minute and puts every block in
//! the checked stretch that did not come through ZeroMQ into the same stream,
//! so it is handled exactly as if it had. A block gets one round to arrive
//! over ZeroMQ before it counts as missed, and the last few heights are looked
//! at again each round for a short reorg.

use crate::chain::rpc_client::RpcClient;
use crate::chain::types::{RpcParam, Type};
use crate::chain::utils::Block;
use std::collections::{HashSet, VecDeque};
use std::ops::RangeInclusive;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast::{Sender, error::RecvError};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

pub const POLL_INTERVAL_SECS: u64 = 60;
/// Heights below the highest one checked that are checked again each round
pub const LOOKBACK: u64 = 6;
/// At most this many heights per round; a longer gap is worked off over rounds
pub const MAX_PER_ROUND: u64 = 144;
const RECENT_CAPACITY: usize = 1_024;

/// Hashes of the blocks that went through the stream lately, oldest first out
#[derive(Debug, Default)]
pub struct RecentBlocks {
    order: VecDeque<String>,
    set: HashSet<String>,
}

impl RecentBlocks {
    /// Records `hash`; false when it was there already
    pub fn insert(&mut self, hash: String) -> bool {
        if self.set.contains(&hash) {
            return false;
        }
        if self.order.len() == RECENT_CAPACITY
            && let Some(oldest) = self.order.pop_front()
        {
            self.set.remove(&oldest);
        }
        self.set.insert(hash.clone());
        self.order.push_back(hash);
        true
    }

    pub fn contains(&self, hash: &str) -> bool {
        self.set.contains(hash)
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

/// The heights to check this round: from `LOOKBACK` below `checked`, the
/// highest height checked so far, up to `settled_tip`, the node's tip one
/// round ago, at most `MAX_PER_ROUND` of them
pub fn heights_to_check(checked: u64, settled_tip: u64) -> Option<RangeInclusive<u64>> {
    let start = checked.saturating_sub(LOOKBACK).max(1);
    let end = settled_tip.min(start + MAX_PER_ROUND - 1);
    if end < start { None } else { Some(start..=end) }
}

struct State {
    checked: Option<u64>,
    settled_tip: Option<u64>,
}

pub fn spawn(
    cancellation_token: CancellationToken,
    client_type: Type,
    rpc: RpcClient,
    block_sender: Sender<Block>,
) {
    let recent = Arc::new(Mutex::new(RecentBlocks::default()));

    // Every block that goes through the stream, from ZeroMQ or from here
    {
        let recent = recent.clone();
        let mut receiver = block_sender.subscribe();
        let cancellation_token = cancellation_token.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    block = receiver.recv() => match block {
                        Ok(block) => {
                            if let Ok(mut recent) = recent.lock() {
                                recent.insert(hex::encode(block.block_hash()));
                            }
                        }
                        Err(RecvError::Closed) => break,
                        Err(RecvError::Lagged(_)) => {}
                    },
                    _ = cancellation_token.cancelled() => break,
                }
            }
        });
    }

    tokio::spawn(async move {
        info!(
            "Checking every {POLL_INTERVAL_SECS}s for {} blocks that ZeroMQ did not deliver",
            rpc.symbol
        );
        let mut state = State {
            checked: None,
            settled_tip: None,
        };
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)) => {
                    if let Err(e) = round(&rpc, client_type, &block_sender, &recent, &mut state).await {
                        debug!("Could not check {} for missed blocks: {e}", rpc.symbol);
                    }
                }
                _ = cancellation_token.cancelled() => break,
            }
        }
    });
}

async fn round(
    rpc: &RpcClient,
    client_type: Type,
    block_sender: &Sender<Block>,
    recent: &Arc<Mutex<RecentBlocks>>,
    state: &mut State,
) -> anyhow::Result<()> {
    let tip = rpc.request::<u64>("getblockcount", None).await?;

    let (checked, settled_tip) = match (state.checked, state.settled_tip) {
        (Some(checked), Some(settled_tip)) => (checked, settled_tip),
        _ => {
            // First round: what is there now counts as seen. The backend's
            // rescan at startup covers it.
            for height in tip.saturating_sub(LOOKBACK).max(1)..=tip {
                let hash = block_hash(rpc, height).await?;
                if let Ok(mut recent) = recent.lock() {
                    recent.insert(hash);
                }
            }
            state.checked = Some(tip);
            state.settled_tip = Some(tip);
            return Ok(());
        }
    };

    if let Some(heights) = heights_to_check(checked, settled_tip) {
        let end = *heights.end();
        for height in heights {
            let hash = block_hash(rpc, height).await?;
            let seen = recent.lock().map(|r| r.contains(&hash)).unwrap_or(true);
            if seen {
                continue;
            }

            let raw = rpc
                .request::<String>("getblock", Some(&[RpcParam::Str(&hash), RpcParam::Int(0)]))
                .await?;
            let block = Block::parse_hex(&client_type, &raw)?;
            if let Ok(mut recent) = recent.lock() {
                recent.insert(hash.clone());
            }
            warn!(
                "{} block {height} ({hash}) did not arrive over ZeroMQ; processing it from RPC",
                rpc.symbol
            );
            if block_sender.send(block).is_err() {
                debug!("No one is listening for {} blocks", rpc.symbol);
            }
        }
        state.checked = Some(checked.max(end));
    }

    state.settled_tip = Some(tip);
    Ok(())
}

async fn block_hash(rpc: &RpcClient, height: u64) -> anyhow::Result<String> {
    rpc.request::<String>("getblockhash", Some(&[RpcParam::Int(height as i64)]))
        .await
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn recent_blocks_records_each_hash_once() {
        let mut recent = RecentBlocks::default();
        assert!(recent.is_empty());
        assert!(recent.insert("a".into()));
        assert!(!recent.insert("a".into()));
        assert!(recent.insert("b".into()));
        assert!(recent.contains("a"));
        assert!(recent.contains("b"));
        assert!(!recent.contains("c"));
        assert_eq!(recent.len(), 2);
    }

    #[test]
    fn recent_blocks_forgets_the_oldest_when_full() {
        let mut recent = RecentBlocks::default();
        for i in 0..RECENT_CAPACITY + 1 {
            recent.insert(i.to_string());
        }
        assert_eq!(recent.len(), RECENT_CAPACITY);
        assert!(!recent.contains("0"));
        assert!(recent.contains("1"));
        assert!(recent.contains(&RECENT_CAPACITY.to_string()));
    }

    #[test]
    fn heights_to_check_goes_back_for_reorgs_and_up_to_the_settled_tip() {
        // Nothing new: only the lookback
        assert_eq!(heights_to_check(100, 100), Some(94..=100));
        // Two new blocks a round ago
        assert_eq!(heights_to_check(100, 102), Some(94..=102));
        // Near the start of the chain
        assert_eq!(heights_to_check(3, 5), Some(1..=5));
    }

    #[test]
    fn heights_to_check_works_off_a_long_gap_over_rounds() {
        assert_eq!(heights_to_check(1_000, 5_000), Some(994..=1_137));
    }

    #[test]
    fn heights_to_check_skips_a_tip_below_the_start() {
        // A reorg to a shorter chain
        assert_eq!(heights_to_check(100, 90), None);
    }
}
