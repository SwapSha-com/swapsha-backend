//! Bitcoin on the BLAKE2b chain (Bitcoin Knots v29.4.1.knots20260508+).
//!
//! - [`unified`]: the opt-in SIGHASH_UNIFIED signature hash (Knots PR #357).
//!   Transactions carrying it are invalid on the SHA-256 chain, so they cannot
//!   be replayed there.
//! - [`header`]: 80-byte v1 and 164-byte v2 block headers, BLAKE2b block
//!   hashing, and a block parser that rust-bitcoin cannot do for v2 headers.

pub mod header;
#[cfg(test)]
mod regtest;
pub mod unified;

pub use header::{BlockHeader, HeaderError, MAINNET_FORK_HASH, MAINNET_FORK_HEIGHT, parse_block};
pub use unified::{
    SIGHASH_ALL_UNIFIED, SIGHASH_UNIFIED, SighashMode, UnifiedScriptType, UnifiedSighashError,
    unified_sighash,
};
