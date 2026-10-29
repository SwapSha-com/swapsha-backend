//! Block headers on both sides of the BLAKE2b fork.
//!
//! v1 (80 bytes) is the original header, hashed with double SHA-256.
//! v2 (164 bytes) sets bit 31 of the version and is hashed with BLAKE2b-256
//! through the tagged pre-hashes in Knots `src/primitives/block.cpp`.
//! Verified against Knots `src/test/data/block_header_v2.json`.

use super::unified::tagged_hash;
use bitcoin::{
    BlockHash, Transaction,
    consensus::{Decodable, encode::VarInt},
    hashes::{Hash, sha256d},
    io::Cursor,
};
use blake2::{Blake2b, Digest, digest::consts::U32};

/// Height of the first BLAKE2b block on mainnet.
pub const MAINNET_FORK_HEIGHT: u32 = 961_640;
/// Hash of that block, display order.
pub const MAINNET_FORK_HASH: &str =
    "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb";

const V1_SIZE: usize = 80;
const V2_SIZE: usize = 164;
const VERSION_HEADER_V2_FLAG: u32 = 0x8000_0000;
const FLAG_USE_TIME_OFFSET: u8 = 4;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
/// Errors from parsing headers and blocks.
pub enum HeaderError {
    #[error("header too short: {0} bytes")]
    /// Fewer bytes than the header version needs.
    TooShort(usize),
    #[error("invalid transactions after header: {0}")]
    /// The transaction list after the header did not decode.
    Transactions(String),
    #[error("{0} trailing bytes after the last transaction")]
    /// Bytes left over after the last transaction.
    Trailing(usize),
}

/// A block header in either version. Byte arrays are in wire order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockHeader {
    /// Bit 31 of the version: a 164-byte BLAKE2b header.
    pub is_v2: bool,
    /// Version without the v2 flag.
    pub version: u32,
    /// Previous block hash.
    pub prev_block: [u8; 32],
    /// Merkle root of the transactions.
    pub merkle_root: [u8; 32],
    /// Real block time, with the time offset applied when flagged.
    pub time: u32,
    /// Compact difficulty target.
    pub bits: u32,
    /// Nonce.
    pub nonce: u32,
    /// v2: second nonce.
    pub nonce2: u32,
    /// v2: third nonce.
    pub nonce3: u32,
    /// v2: Stratum v1 extranonce.
    pub extranonce: [u8; 16],
    /// v2: offset subtracted from the time on the wire when flagged.
    pub time_offset: u32,
    /// v2: transaction count.
    pub tx_count: u16,
    /// v2: header flags (low two bits pick the ASIC profile).
    pub flags: u8,
    /// v2: leading mask bits to clear.
    pub xor_key_mask_clear_bits: u8,
    /// v2: PoW XOR key.
    pub xor_key: [u8; 16],
    /// v2: block height.
    pub height: i32,
    /// v2: merge-mining right-hand side.
    pub mm_rhs: [u8; 32],
}

fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn arr<const N: usize>(b: &[u8], at: usize) -> [u8; N] {
    b[at..at + N].try_into().unwrap()
}

impl BlockHeader {
    /// Size this header takes on the wire.
    pub fn size(&self) -> usize {
        if self.is_v2 { V2_SIZE } else { V1_SIZE }
    }

    /// Parse a header from the start of `b` (extra bytes are ignored).
    pub fn parse(b: &[u8]) -> Result<Self, HeaderError> {
        if b.len() < V1_SIZE {
            return Err(HeaderError::TooShort(b.len()));
        }
        let full_version = u32le(b, 0);
        let is_v2 = full_version & VERSION_HEADER_V2_FLAG != 0;
        if is_v2 && b.len() < V2_SIZE {
            return Err(HeaderError::TooShort(b.len()));
        }

        let mut h = BlockHeader {
            is_v2,
            version: full_version & !VERSION_HEADER_V2_FLAG,
            prev_block: arr(b, 4),
            merkle_root: arr(b, 36),
            time: u32le(b, 68),
            bits: u32le(b, 72),
            nonce: u32le(b, 76),
            nonce2: 0,
            nonce3: 0,
            extranonce: [0; 16],
            time_offset: 0,
            tx_count: 0,
            flags: 0,
            xor_key_mask_clear_bits: 0,
            xor_key: [0; 16],
            height: 0,
            mm_rhs: [0; 32],
        };
        if is_v2 {
            h.nonce2 = u32le(b, 80);
            h.nonce3 = u32le(b, 84);
            h.extranonce = arr(b, 88);
            h.time_offset = u32le(b, 104);
            h.tx_count = u16::from_le_bytes(arr(b, 108));
            h.flags = b[110];
            h.xor_key_mask_clear_bits = b[111];
            h.xor_key = arr(b, 112);
            h.height = i32::from_le_bytes(arr(b, 128));
            h.mm_rhs = arr(b, 132);
            if h.flags & FLAG_USE_TIME_OFFSET != 0 {
                h.time = h.time.wrapping_add(h.time_offset);
            }
        }
        Ok(h)
    }

    fn complete_version(&self) -> u32 {
        (if self.is_v2 {
            VERSION_HEADER_V2_FLAG
        } else {
            0
        }) | (self.version & !VERSION_HEADER_V2_FLAG)
    }

    fn time_on_wire(&self) -> u32 {
        if self.flags & FLAG_USE_TIME_OFFSET != 0 {
            self.time.wrapping_sub(self.time_offset)
        } else {
            self.time
        }
    }

    /// Wire encoding (80 or 164 bytes).
    pub fn serialize(&self) -> Vec<u8> {
        let mut o = Vec::with_capacity(self.size());
        o.extend(self.complete_version().to_le_bytes());
        o.extend(self.prev_block);
        o.extend(self.merkle_root);
        o.extend(self.time_on_wire().to_le_bytes());
        o.extend(self.bits.to_le_bytes());
        o.extend(self.nonce.to_le_bytes());
        if self.is_v2 {
            o.extend(self.nonce2.to_le_bytes());
            o.extend(self.nonce3.to_le_bytes());
            o.extend(self.extranonce);
            o.extend(self.time_offset.to_le_bytes());
            o.extend(self.tx_count.to_le_bytes());
            o.push(self.flags);
            o.push(self.xor_key_mask_clear_bits);
            o.extend(self.xor_key);
            o.extend(self.height.to_le_bytes());
            o.extend(self.mm_rhs);
        }
        o
    }

    /// Block hash (BLAKE2b for v2, double SHA-256 for v1).
    pub fn block_hash(&self) -> BlockHash {
        if !self.is_v2 {
            return BlockHash::from_raw_hash(sha256d::Hash::hash(&self.serialize()));
        }

        let zeros16 = [0u8; 16];
        let mut prev_display = self.prev_block;
        prev_display.reverse();

        let xor_key_hash = tagged_hash("Bitcoin block hash PoW XOR key", &[&self.xor_key]);

        let mut mask = [0u8; 32];
        if self.xor_key != [0; 16] {
            mask = tagged_hash("Bitcoin block hash PoW XOR mask", &[&self.xor_key]);
            let clear_bytes = (self.xor_key_mask_clear_bits / 8) as usize;
            mask[..clear_bytes.min(32)].fill(0);
            if clear_bytes < 32 {
                mask[clear_bytes] &= 0xff >> (self.xor_key_mask_clear_bits % 8);
            }
        }

        let mut prev_hidden = tagged_hash("Bitcoin prevblock header, hashed", &[&prev_display]);

        let h1 = tagged_hash(
            "Bitcoin block header 1",
            &[
                &self.complete_version().to_le_bytes(),
                &prev_display,
                &self.height.to_le_bytes(),
                &self.merkle_root,
                &self.time_on_wire().to_le_bytes(),
                &[0u8], // reserved for 40-bit time
                &self.bits.to_le_bytes(),
                &(self.tx_count as u32).to_le_bytes(),
                &[self.flags],
                &[self.xor_key_mask_clear_bits],
                &xor_key_hash,
            ],
        );
        let h2 = tagged_hash(
            "Merge-mining hook",
            &[&h1, &zeros16, &zeros16, &self.mm_rhs],
        );

        let blake = |parts: &[&[u8]]| -> [u8; 32] {
            let mut h = Blake2b::<U32>::new();
            for p in parts {
                h.update(p);
            }
            h.finalize().into()
        };

        let first = blake(&[&0u32.to_le_bytes(), &h2, &self.extranonce]);

        let n = self.nonce.to_le_bytes();
        let n2 = self.nonce2.to_le_bytes();
        let n3 = self.nonce3.to_le_bytes();
        let off = self.time_offset.to_le_bytes();
        let second = match self.flags & 3 {
            3 => blake(&[&[0u8; 80], &h2, &n, &n2, &off, &n3, &first]),
            2 => blake(&[&[0u8; 48], &h2, &n, &n2, &off, &n3, &first]),
            1 => blake(&[&n, &n2, &n3, &off, &first, &h2]),
            _ => {
                prev_hidden[..6].fill(0);
                blake(&[&prev_hidden, &n, &n2, &off, &n3, &first])
            }
        };

        // Knots writes (second ^ mask) back to front: display order is
        // second ^ mask, wire (internal) order is its reverse.
        let mut internal = [0u8; 32];
        for i in 0..32 {
            internal[31 - i] = second[i] ^ mask[i];
        }
        BlockHash::from_byte_array(internal)
    }
}

/// Parse a serialized block with either header version into its header and
/// transactions. rust-bitcoin's `Block` decoder only reads 80-byte headers.
pub fn parse_block(b: &[u8]) -> Result<(BlockHeader, Vec<Transaction>), HeaderError> {
    let header = BlockHeader::parse(b)?;
    let mut cur = Cursor::new(&b[header.size()..]);
    let count = VarInt::consensus_decode(&mut cur)
        .map_err(|e| HeaderError::Transactions(e.to_string()))?
        .0;
    let mut txs = Vec::with_capacity(count.min(100_000) as usize);
    for _ in 0..count {
        txs.push(
            Transaction::consensus_decode(&mut cur)
                .map_err(|e| HeaderError::Transactions(e.to_string()))?,
        );
    }
    let used = cur.position() as usize;
    let rest = b.len() - header.size() - used;
    if rest != 0 {
        return Err(HeaderError::Trailing(rest));
    }
    Ok((header, txs))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(s: &str) -> Vec<u8> {
        let mut v = hex::decode(s).unwrap();
        v.reverse();
        v
    }

    #[test]
    fn knots_v2_vectors() {
        let raw = include_str!("../../../tests/data/block_header_v2.json");
        let data: serde_json::Value = serde_json::from_str(raw).unwrap();
        let headers = data["headers"].as_array().unwrap();
        assert_eq!(headers.len(), 5);
        for v in headers {
            let f = &v["fields"];
            let n = |k: &str| f[k].as_u64().unwrap();
            let h = BlockHeader {
                is_v2: true,
                version: n("nVersion") as u32,
                prev_block: display(f["hashPrevBlock"].as_str().unwrap())
                    .try_into()
                    .unwrap(),
                merkle_root: display(f["hashMerkleRoot"].as_str().unwrap())
                    .try_into()
                    .unwrap(),
                time: n("nTime") as u32,
                bits: n("nBits") as u32,
                nonce: n("nNonce") as u32,
                nonce2: n("m_nonce2") as u32,
                nonce3: n("m_nonce3") as u32,
                extranonce: display(f["m_extranonce"].as_str().unwrap())
                    .try_into()
                    .unwrap(),
                time_offset: n("m_time_offset") as u32,
                tx_count: n("m_txcount") as u16,
                flags: n("m_flags") as u8,
                xor_key_mask_clear_bits: n("m_xor_key_mask_clear_bits") as u8,
                xor_key: display(f["m_xor_key"].as_str().unwrap())
                    .try_into()
                    .unwrap(),
                height: n("m_height") as i32,
                mm_rhs: display(f["m_mm_rhs"].as_str().unwrap()).try_into().unwrap(),
            };
            let name = v["name"].as_str().unwrap();
            assert_eq!(
                hex::encode(h.serialize()),
                v["serialized"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                h.block_hash().to_string(),
                v["block_hash"].as_str().unwrap(),
                "{name}"
            );

            let parsed =
                BlockHeader::parse(&hex::decode(v["serialized"].as_str().unwrap()).unwrap())
                    .unwrap();
            assert_eq!(parsed, h, "{name}");
        }
    }

    #[test]
    fn v1_genesis() {
        let raw = hex::decode("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c").unwrap();
        let h = BlockHeader::parse(&raw).unwrap();
        assert!(!h.is_v2);
        assert_eq!(
            h.block_hash().to_string(),
            "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
        );
    }

    #[test]
    fn parse_block_with_v2_header() {
        let raw = include_str!("../../../tests/data/block_header_v2.json");
        let data: serde_json::Value = serde_json::from_str(raw).unwrap();
        let header = hex::decode(data["headers"][0]["serialized"].as_str().unwrap()).unwrap();
        // Bitcoin genesis coinbase transaction.
        let coinbase = hex::decode("01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000").unwrap();
        let mut block = header.clone();
        block.push(1);
        block.extend(&coinbase);

        let (h, txs) = parse_block(&block).unwrap();
        assert!(h.is_v2);
        assert_eq!(txs.len(), 1);
        assert_eq!(
            txs[0].compute_txid().to_string(),
            "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b"
        );

        block.push(0);
        assert_eq!(parse_block(&block), Err(HeaderError::Trailing(1)));
    }
}
