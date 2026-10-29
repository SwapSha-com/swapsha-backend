//! SIGHASH_UNIFIED (0x20), the Bitcoin Knots opt-in signature hash.
//!
//! Spec: bitcoinknots/bitcoin `doc/unified-sighash.md` at v29.4.1.knots20260508.
//! Verified against all 166 vectors in `src/test/data/unified_sighash.json`.

use bitcoin::{
    ScriptBuf, Transaction, TxOut,
    consensus::{Encodable, encode::VarInt},
    hashes::{Hash, HashEngine, sha256},
};

/// The opt-in bit.
pub const SIGHASH_UNIFIED: u8 = 0x20;
/// SIGHASH_ALL with the opt-in: what SwapSha signs every BLAKE2b spend with.
pub const SIGHASH_ALL_UNIFIED: u8 = 0x21;

const SIGHASH_NONE: u8 = 0x02;
const SIGHASH_SINGLE: u8 = 0x03;
const SIGHASH_ANYONECANPAY: u8 = 0x80;
const TAPSCRIPT_LEAF_VERSION: u8 = 0xc0;

/// Which signature hash a transaction is signed with.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum SighashMode {
    /// The signature hashes Bitcoin has always used. Valid on both chains.
    #[default]
    Legacy,
    /// SIGHASH_UNIFIED. Valid only on the BLAKE2b chain.
    Unified,
}

/// Script type byte that domain-separates the hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum UnifiedScriptType {
    /// Bare script or P2SH (ECDSA)
    Base = 0,
    /// Native or nested segwit v0 (ECDSA)
    WitnessV0 = 1,
    /// Taproot key path (Schnorr)
    Taproot = 2,
    /// Taproot script path (Schnorr)
    Tapscript = 3,
}

/// Cases the rules reject.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum UnifiedSighashError {
    /// The hash type lacks the 0x20 bit.
    #[error("hash type 0x{0:02x} does not opt in to SIGHASH_UNIFIED")]
    NotOptedIn(u8),
    /// Input index past the end.
    #[error("input index {0} out of range")]
    InputIndex(usize),
    /// Prevout count differs from input count.
    #[error("one spent output is required per input")]
    PrevoutCount,
    /// Taproot refuses hash types BIP341 does not define.
    #[error("hash type 0x{0:02x} is undefined for taproot")]
    TaprootHashType(u8),
    /// Base and segwit v0 need a script code.
    #[error("script code is required for base and segwit v0 inputs")]
    MissingScriptCode,
    /// Tapscript needs the leaf script.
    #[error("leaf script is required for tapscript inputs")]
    MissingLeafScript,
    /// SINGLE with no output at the input's index.
    #[error("SIGHASH_SINGLE without a matching output")]
    SingleWithoutOutput,
}

/// Optional parts of the message, by script type.
#[derive(Debug, Clone, Default)]
pub struct UnifiedOptions<'a> {
    /// Base and WitnessV0: the script code.
    pub script_code: Option<&'a ScriptBuf>,
    /// Tapscript: the leaf script.
    pub leaf_script: Option<&'a ScriptBuf>,
    /// Tapscript: leaf version (default 0xc0).
    pub leaf_version: Option<u8>,
    /// Tapscript: position of the last executed OP_CODESEPARATOR.
    pub codeseparator_pos: Option<u32>,
    /// Taproot and Tapscript: the annex, including its 0x50 prefix.
    pub annex: Option<&'a [u8]>,
}

fn enc<T: Encodable + ?Sized>(v: &T) -> Vec<u8> {
    let mut out = Vec::new();
    v.consensus_encode(&mut out).expect("vec write");
    out
}

fn ser_string(b: &[u8]) -> Vec<u8> {
    let mut out = enc(&VarInt(b.len() as u64));
    out.extend_from_slice(b);
    out
}

/// BIP340 tagged hash.
pub(crate) fn tagged_hash(tag: &str, parts: &[&[u8]]) -> [u8; 32] {
    let tag = sha256::Hash::hash(tag.as_bytes());
    let mut e = sha256::Hash::engine();
    e.input(tag.as_byte_array());
    e.input(tag.as_byte_array());
    for p in parts {
        e.input(p);
    }
    sha256::Hash::from_engine(e).to_byte_array()
}

fn sha(data: &[u8]) -> [u8; 32] {
    sha256::Hash::hash(data).to_byte_array()
}

/// Compute the SIGHASH_UNIFIED digest for input `index`. Returns the 32 bytes
/// that are signed (ECDSA or Schnorr), in the order the signer consumes them.
pub fn unified_sighash(
    tx: &Transaction,
    index: usize,
    hash_type: u8,
    prevouts: &[TxOut],
    script_type: UnifiedScriptType,
    opts: &UnifiedOptions,
) -> Result<[u8; 32], UnifiedSighashError> {
    if hash_type & SIGHASH_UNIFIED == 0 {
        return Err(UnifiedSighashError::NotOptedIn(hash_type));
    }
    if index >= tx.input.len() {
        return Err(UnifiedSighashError::InputIndex(index));
    }
    if prevouts.len() != tx.input.len() {
        return Err(UnifiedSighashError::PrevoutCount);
    }

    let output_type = hash_type & 0x1f;
    let anyone_can_pay = hash_type & SIGHASH_ANYONECANPAY != 0;
    let taproot = matches!(
        script_type,
        UnifiedScriptType::Taproot | UnifiedScriptType::Tapscript
    );

    if taproot
        && (hash_type & !(0x1f | SIGHASH_ANYONECANPAY | SIGHASH_UNIFIED) != 0
            || !matches!(output_type, 0x01 | SIGHASH_NONE | SIGHASH_SINGLE))
    {
        return Err(UnifiedSighashError::TaprootHashType(hash_type));
    }

    let mut m: Vec<u8> = Vec::with_capacity(256);
    m.push(0x00); // epoch
    m.push(hash_type);
    m.extend_from_slice(&tx.version.0.to_le_bytes());
    m.extend_from_slice(&tx.lock_time.to_consensus_u32().to_le_bytes());
    m.push(0x00); // locktime is five bytes; the high one is reserved

    if !anyone_can_pay {
        let mut prev = Vec::new();
        let mut amounts = Vec::new();
        let mut scripts = Vec::new();
        let mut sequences = Vec::new();
        for (txin, out) in tx.input.iter().zip(prevouts) {
            prev.extend(enc(&txin.previous_output));
            amounts.extend(out.value.to_sat().to_le_bytes());
            scripts.extend(enc(&out.script_pubkey));
            sequences.extend(txin.sequence.0.to_le_bytes());
        }
        m.extend(sha(&prev));
        m.extend(sha(&amounts));
        m.extend(sha(&scripts));
        m.extend(sha(&sequences));
    }

    if output_type != SIGHASH_NONE && output_type != SIGHASH_SINGLE {
        let outs: Vec<u8> = tx.output.iter().flat_map(enc).collect();
        m.extend(sha(&outs));
    }

    m.push(script_type as u8);

    if anyone_can_pay {
        let txin = &tx.input[index];
        m.extend(enc(&txin.previous_output));
        m.extend(enc(&prevouts[index]));
        m.extend(txin.sequence.0.to_le_bytes());
    } else {
        m.extend((index as u32).to_le_bytes());
    }

    if !taproot {
        let code = opts
            .script_code
            .ok_or(UnifiedSighashError::MissingScriptCode)?;
        m.extend(enc(code));
    } else {
        m.push(u8::from(opts.annex.is_some()));
        if let Some(annex) = opts.annex {
            m.extend(sha(&ser_string(annex)));
        }
    }

    if output_type == SIGHASH_SINGLE {
        let out = tx
            .output
            .get(index)
            .ok_or(UnifiedSighashError::SingleWithoutOutput)?;
        m.extend(sha(&enc(out)));
    }

    if script_type == UnifiedScriptType::Tapscript {
        let leaf = opts
            .leaf_script
            .or(opts.script_code)
            .ok_or(UnifiedSighashError::MissingLeafScript)?;
        let ver = opts.leaf_version.unwrap_or(TAPSCRIPT_LEAF_VERSION);
        m.extend(tagged_hash("TapLeaf", &[&[ver], &enc(leaf)]));
        m.push(0x00); // key version
        m.extend(opts.codeseparator_pos.unwrap_or(u32::MAX).to_le_bytes());
    }

    Ok(tagged_hash("UnifiedSighash", &[&m]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::{Amount, consensus::deserialize};

    #[test]
    fn knots_vectors() {
        let raw = include_str!("../../../tests/data/unified_sighash.json");
        let rows: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        let mut checked = 0;
        for row in rows.iter().skip(1) {
            let r = row.as_array().unwrap();
            let code = ScriptBuf::from_bytes(hex::decode(r[0].as_str().unwrap()).unwrap());
            let tx: Transaction =
                deserialize(&hex::decode(r[1].as_str().unwrap()).unwrap()).unwrap();
            let index = r[2].as_u64().unwrap() as usize;
            let hash_type = r[3].as_u64().unwrap() as u8;
            let script_type = match r[4].as_u64().unwrap() {
                0 => UnifiedScriptType::Base,
                1 => UnifiedScriptType::WitnessV0,
                2 => UnifiedScriptType::Taproot,
                _ => UnifiedScriptType::Tapscript,
            };
            let prevouts: Vec<TxOut> = r[5]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| TxOut {
                    value: Amount::from_sat(p[0].as_u64().unwrap()),
                    script_pubkey: ScriptBuf::from_bytes(
                        hex::decode(p[1].as_str().unwrap()).unwrap(),
                    ),
                })
                .collect();
            let opts = if script_type == UnifiedScriptType::Tapscript {
                UnifiedOptions {
                    leaf_script: Some(&code),
                    ..Default::default()
                }
            } else {
                UnifiedOptions {
                    script_code: Some(&code),
                    ..Default::default()
                }
            };
            let got =
                unified_sighash(&tx, index, hash_type, &prevouts, script_type, &opts).unwrap();
            assert_eq!(hex::encode(got), r[6].as_str().unwrap(), "vector {checked}");
            checked += 1;
        }
        assert_eq!(checked, 166);
    }

    #[test]
    fn requires_opt_in() {
        let tx = Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: vec![],
            output: vec![],
        };
        assert_eq!(
            unified_sighash(
                &tx,
                0,
                0x01,
                &[],
                UnifiedScriptType::Base,
                &Default::default()
            ),
            Err(UnifiedSighashError::NotOptedIn(0x01))
        );
    }
}
