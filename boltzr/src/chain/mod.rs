use crate::chain::types::Type;
use crate::chain::utils::{Block, Outpoint, Transaction};
use crate::db::helpers::chain_tip::ChainTipHelper;
use anyhow::Result;
use async_trait::async_trait;
use boltz_core::Network;
use elements::ZeroConfToolConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot};

pub mod bumper;
pub mod chain_client;
pub mod elements;
pub mod elements_client;
mod mempool_client;
pub mod mrh_watcher;
mod rpc_client;
pub mod types;
pub mod utils;
pub mod zmq_client;

#[derive(PartialEq, Debug, Clone)]
pub enum Transactions {
    Single(Transaction),
    Multiple(Arc<Vec<Transaction>>),
}

impl Transactions {
    pub fn iter(&self) -> Box<dyn Iterator<Item = &Transaction> + '_ + Send + Sync> {
        match self {
            Transactions::Single(tx) => Box::new(std::iter::once(tx)),
            Transactions::Multiple(transactions) => Box::new(transactions.iter()),
        }
    }
}

#[derive(Deserialize, Serialize, PartialEq, Debug, Clone, Default)]
pub struct Mempool {
    /// Extra mempool.space URLs; merged with the top-level mempoolSpace
    pub urls: Option<Vec<String>>,

    /// Reject mempool.space fees above max(multiplier * bitcoind_fee, bitcoind_fee + delta)
    #[serde(rename = "maxFeeMultiplier")]
    pub max_fee_multiplier: Option<f64>,

    /// Absolute sat/vbyte delta added to bitcoind's estimate; used alongside the multiplier
    #[serde(rename = "maxFeeDelta")]
    pub max_fee_delta: Option<f64>,

    /// Reject cached mempool.space fees older than this many seconds
    #[serde(rename = "maxAgeSecs")]
    pub max_age_secs: Option<u64>,

    /// Reject mempool.space fees when its reported block tip trails the local node by more than this many blocks
    #[serde(rename = "maxBlockLag")]
    pub max_block_lag: Option<u64>,
}

#[derive(Deserialize, Serialize, PartialEq, Debug, Clone, Default)]
pub struct Config {
    host: String,
    port: u16,

    cookie: Option<String>,

    user: Option<String>,
    password: Option<String>,

    #[serde(rename = "mempoolSpace")]
    mempool_space: Option<String>,

    mempool: Option<Mempool>,

    wallet: Option<String>,

    /// SwapSha: ZeroMQ addresses to use instead of the ones the node reports,
    /// for a node reached at other ports than its own (the StartOS bridge)
    zmq: Option<ZmqOverrides>,

    /// Minimum fee rate in sat/vbyte used as floor for fee estimation
    #[serde(rename = "feeFloor")]
    pub fee_floor: Option<f64>,
}

/// SwapSha: ZeroMQ addresses that replace the ones from getzmqnotifications.
/// On StartOS a dependency is reached through the host bridge at ports the
/// OS assigns, while the node reports its own (tcp://0.0.0.0:28332), and the
/// sidecar would otherwise put the RPC host in front of the node's port.
#[derive(Deserialize, Serialize, PartialEq, Debug, Clone, Default)]
pub struct ZmqOverrides {
    pub rawtx: Option<String>,
    pub rawblock: Option<String>,
}

impl Config {
    /// Whether a mempool.space style fee source is configured.
    pub fn uses_mempool_space(&self) -> bool {
        self.mempool_space.is_some() || self.mempool.as_ref().is_some_and(|m| m.urls.is_some())
    }
}

#[derive(Deserialize, Serialize, PartialEq, Debug, Clone)]
pub struct LiquidConfig {
    #[serde(flatten)]
    base: Config,

    #[serde(rename = "zeroConfTool")]
    pub zero_conf_tool: Option<ZeroConfToolConfig>,
}

#[async_trait]
pub trait BaseClient {
    fn kind(&self) -> String;
    fn symbol(&self) -> String;

    async fn connect(&mut self) -> Result<()>;
}

#[async_trait]
pub trait Client: BaseClient {
    fn chain_type(&self) -> Type;
    fn network(&self) -> Network;

    /// SwapSha: `Unified` for the BLAKE2b chain, so every transaction signed
    /// for this chain carries SIGHASH_UNIFIED and cannot be replayed.
    fn sighash_mode(&self) -> boltz_core::bitcoin::blake2b::SighashMode {
        boltz_core::bitcoin::blake2b::SighashMode::Legacy
    }

    /// Returns the end height of the rescan
    async fn rescan(
        &self,
        chain_tip_repo: Arc<dyn ChainTipHelper + Send + Sync>,
        start_height: u64,
        relevant_inputs: &HashSet<Outpoint>,
        relevant_outputs: &HashSet<Vec<u8>>,
    ) -> Result<u64>;

    async fn scan_mempool(
        &self,
        relevant_inputs: &HashSet<Outpoint>,
        relevant_outputs: &HashSet<Vec<u8>>,
    ) -> Result<()>;

    async fn network_info(&self) -> Result<types::NetworkInfo>;
    async fn blockchain_info(&self) -> Result<types::BlockchainInfo>;

    /// Fee estimation in sat/vbyte
    async fn estimate_fee(&self) -> Result<f64>;

    async fn raw_transaction(&self, tx_id: &str) -> Result<String>;
    async fn raw_transaction_verbose(&self, tx_id: &str) -> Result<types::RawTransactionVerbose>;

    /// SwapSha D38: the value in satoshis of output `vout` of `tx_id` in the
    /// confirmed UTXO set (`gettxout <txid> <vout> false`, so a spend that is
    /// only in the mempool does not hide it). `None` when no confirmed
    /// unspent output matches. A node without txindex cannot return the
    /// confirmed parents of a pending transaction, but it can return this.
    async fn confirmed_output_value(&self, _tx_id: &str, _vout: u32) -> Result<Option<u64>> {
        Err(anyhow::anyhow!(
            "{} client has no confirmed output lookup",
            self.symbol()
        ))
    }

    async fn send_raw_transaction(&self, tx: &str) -> Result<String>;

    async fn list_unspent(&self, wallet: Option<&str>) -> Result<Vec<types::UnspentOutput>>;
    async fn get_new_address(
        &self,
        wallet: Option<&str>,
        label: &str,
        address_type: Option<&str>,
    ) -> Result<String>;
    async fn dump_blinding_key(&self, wallet: Option<&str>, address: &str) -> Result<String>;
    async fn sign_raw_transaction_with_wallet(
        &self,
        wallet: Option<&str>,
        tx: &str,
    ) -> Result<types::SignRawTransactionResponse>;

    #[cfg(test)]
    async fn request_wallet(
        &self,
        wallet: Option<&str>,
        method: &str,
        params: Option<&[types::RpcParam<'_>]>,
    ) -> Result<serde_json::Value>;

    fn zero_conf_safe(&self, transaction: &Transaction) -> oneshot::Receiver<bool>;

    fn tx_receiver(&self) -> broadcast::Receiver<(Transactions, bool)>;
    fn block_receiver(&self) -> broadcast::Receiver<(u64, Block)>;
}

#[cfg(test)]
mod test {
    use super::*;
    use std::collections::HashMap;

    const NO_INDEX: &str = "No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries.";

    /// SwapSha D38: a node without txindex. It returns a parent by id only
    /// from its mempool; of a confirmed parent it knows only the outputs that
    /// are still unspent in a block.
    struct PrunedNode {
        mempool: HashMap<bitcoin::Txid, String>,
        confirmed_outputs: HashMap<(bitcoin::Txid, u32), u64>,
    }

    #[async_trait]
    impl BaseClient for PrunedNode {
        fn kind(&self) -> String {
            "PrunedNode".to_string()
        }

        fn symbol(&self) -> String {
            "SHA256".to_string()
        }

        async fn connect(&mut self) -> Result<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl Client for PrunedNode {
        fn chain_type(&self) -> Type {
            Type::Bitcoin
        }

        fn network(&self) -> Network {
            Network::Regtest
        }

        async fn rescan(
            &self,
            _chain_tip_repo: Arc<dyn ChainTipHelper + Send + Sync>,
            _start_height: u64,
            _relevant_inputs: &HashSet<Outpoint>,
            _relevant_outputs: &HashSet<Vec<u8>>,
        ) -> Result<u64> {
            unimplemented!()
        }

        async fn scan_mempool(
            &self,
            _relevant_inputs: &HashSet<Outpoint>,
            _relevant_outputs: &HashSet<Vec<u8>>,
        ) -> Result<()> {
            unimplemented!()
        }

        async fn network_info(&self) -> Result<types::NetworkInfo> {
            unimplemented!()
        }

        async fn blockchain_info(&self) -> Result<types::BlockchainInfo> {
            unimplemented!()
        }

        async fn estimate_fee(&self) -> Result<f64> {
            unimplemented!()
        }

        async fn raw_transaction(&self, tx_id: &str) -> Result<String> {
            self.mempool
                .get(&tx_id.parse::<bitcoin::Txid>()?)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!(NO_INDEX))
        }

        async fn raw_transaction_verbose(
            &self,
            _tx_id: &str,
        ) -> Result<types::RawTransactionVerbose> {
            unimplemented!()
        }

        async fn confirmed_output_value(&self, tx_id: &str, vout: u32) -> Result<Option<u64>> {
            Ok(self
                .confirmed_outputs
                .get(&(tx_id.parse::<bitcoin::Txid>()?, vout))
                .copied())
        }

        async fn send_raw_transaction(&self, _tx: &str) -> Result<String> {
            unimplemented!()
        }

        async fn list_unspent(&self, _wallet: Option<&str>) -> Result<Vec<types::UnspentOutput>> {
            unimplemented!()
        }

        async fn get_new_address(
            &self,
            _wallet: Option<&str>,
            _label: &str,
            _address_type: Option<&str>,
        ) -> Result<String> {
            unimplemented!()
        }

        async fn dump_blinding_key(&self, _wallet: Option<&str>, _address: &str) -> Result<String> {
            unimplemented!()
        }

        async fn sign_raw_transaction_with_wallet(
            &self,
            _wallet: Option<&str>,
            _tx: &str,
        ) -> Result<types::SignRawTransactionResponse> {
            unimplemented!()
        }

        async fn request_wallet(
            &self,
            _wallet: Option<&str>,
            _method: &str,
            _params: Option<&[types::RpcParam<'_>]>,
        ) -> Result<serde_json::Value> {
            unimplemented!()
        }

        fn zero_conf_safe(&self, _transaction: &Transaction) -> oneshot::Receiver<bool> {
            unimplemented!()
        }

        fn tx_receiver(&self) -> broadcast::Receiver<(Transactions, bool)> {
            unimplemented!()
        }

        fn block_receiver(&self) -> broadcast::Receiver<(u64, Block)> {
            unimplemented!()
        }
    }

    fn input(previous_output: bitcoin::OutPoint) -> bitcoin::TxIn {
        bitcoin::TxIn {
            previous_output,
            script_sig: bitcoin::ScriptBuf::new(),
            sequence: bitcoin::Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: bitcoin::Witness::new(),
        }
    }

    /// A transaction with one output of `value`. It has one (null) input, so
    /// its serialization cannot be mistaken for a segwit marker.
    fn parent(value: u64) -> bitcoin::Transaction {
        bitcoin::Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: vec![input(bitcoin::OutPoint::null())],
            output: vec![bitcoin::TxOut {
                value: bitcoin::Amount::from_sat(value),
                script_pubkey: bitcoin::ScriptBuf::new(),
            }],
        }
    }

    /// Spends output 0 of each parent into one output of `out` sat
    fn spend(parents: &[&bitcoin::Transaction], out: u64) -> Transaction {
        Transaction::Bitcoin(bitcoin::Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: parents
                .iter()
                .map(|p| {
                    input(bitcoin::OutPoint {
                        txid: p.compute_txid(),
                        vout: 0,
                    })
                })
                .collect(),
            output: vec![bitcoin::TxOut {
                value: bitcoin::Amount::from_sat(out),
                script_pubkey: bitcoin::ScriptBuf::new(),
            }],
        })
    }

    #[tokio::test]
    async fn calculate_fee_values_confirmed_parents_without_txindex() {
        let unconfirmed = parent(50_000);
        let confirmed = parent(70_000);
        let node = PrunedNode {
            mempool: HashMap::from([(
                unconfirmed.compute_txid(),
                hex::encode(bitcoin::consensus::serialize(&unconfirmed)),
            )]),
            confirmed_outputs: HashMap::from([((confirmed.compute_txid(), 0), 70_000)]),
        };
        let client = Arc::new(node) as Arc<dyn Client + Send + Sync>;

        let fee = spend(&[&unconfirmed, &confirmed], 119_000)
            .calculate_fee(&client)
            .await
            .unwrap();
        assert_eq!(fee, 1_000);
    }

    #[tokio::test]
    async fn calculate_fee_fails_when_no_source_has_the_parent() {
        let confirmed = parent(70_000);
        let node = PrunedNode {
            mempool: HashMap::new(),
            // spent in a block: gettxout has nothing
            confirmed_outputs: HashMap::new(),
        };
        let client = Arc::new(node) as Arc<dyn Client + Send + Sync>;

        let err = spend(&[&confirmed], 69_000)
            .calculate_fee(&client)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("-txindex"), "{err}");
    }
}
