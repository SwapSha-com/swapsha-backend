//! Replay-protection and header checks against the SwapSha two-node regtest
//! (`swapsha_regtest.sh`): `sha` on 127.0.0.1:18443 never schedules the fork,
//! `blake` on 127.0.0.1:18543 forks to BLAKE2b at height 200.
//!
//! Ignored by default. Run with:
//!   cargo test -p boltz-core --lib blake2b::regtest -- --ignored --test-threads=1

use crate::{
    bitcoin::{
        InputDetail, UncooperativeDetails, blake2b::SighashMode, blake2b::parse_block,
        construct_tx_with_mode, swap_script, swap_tree,
    },
    target_fee::FeeTarget,
    utils::{Destination, InputType, OutputType},
};
use bitcoin::{
    Address, Network, OutPoint, Transaction,
    absolute::LockTime,
    consensus::{deserialize, serialize},
    hashes::{Hash, hash160},
    key::{Keypair, rand::RngCore},
    secp256k1::{Secp256k1, rand},
};
use serde_json::{Value, json};

const FORK_HEIGHT: u64 = 200;

struct Node(u16);

impl Node {
    fn call(&self, method: &str, params: Value) -> Value {
        let res: Value = reqwest::blocking::Client::new()
            .post(format!("http://127.0.0.1:{}/wallet/prefork", self.0))
            .basic_auth("swapsha", Some("swapsha"))
            .json(&json!({ "jsonrpc": "1.0", "id": 1, "method": method, "params": params }))
            .send()
            .expect("node reachable (is swapsha_regtest.sh running?)")
            .json()
            .unwrap();
        assert!(res["error"].is_null(), "{method}: {}", res["error"]);
        res["result"].clone()
    }

    fn height(&self) -> u64 {
        self.call("getblockcount", json!([])).as_u64().unwrap()
    }

    fn mine_to(&self, height: u64) {
        let have = self.height();
        if have < height {
            let to = self.call("getnewaddress", json!([]));
            self.call("generatetoaddress", json!([height - have, to]));
        }
    }

    fn accept(&self, tx: &Transaction) -> Value {
        self.call("testmempoolaccept", json!([[hex::encode(serialize(tx))]]))[0].clone()
    }
}

const SHA: Node = Node(18443);
const BLAKE: Node = Node(18543);

/// Fund `address` from a pre-fork coin on SHA-256 and replay the same bytes
/// onto BLAKE2b, so the output exists on both chains.
fn fund_on_both(address: &Address) -> (Transaction, usize) {
    let psbt = SHA.call(
        "walletcreatefundedpsbt",
        json!([[], [{ address.to_string(): 0.001 }], 0, { "minconf": 50, "fee_rate": 10 }]),
    );
    let signed = SHA.call("walletprocesspsbt", json!([psbt["psbt"]]));
    let raw = SHA.call("finalizepsbt", json!([signed["psbt"]]))["hex"]
        .as_str()
        .unwrap()
        .to_string();
    SHA.call("sendrawtransaction", json!([raw]));
    BLAKE.call("sendrawtransaction", json!([raw]));
    let top = SHA.height().max(BLAKE.height()) + 1;
    SHA.mine_to(top);
    BLAKE.mine_to(top);

    let tx: Transaction = deserialize(&hex::decode(raw).unwrap()).unwrap();
    let vout = tx
        .output
        .iter()
        .position(|o| o.script_pubkey == address.script_pubkey())
        .unwrap();
    (tx, vout)
}

fn destination() -> Address {
    Address::from_script(
        &Address::p2wpkh(
            &bitcoin::CompressedPublicKey(
                Keypair::new(&Secp256k1::new(), &mut rand::thread_rng()).public_key(),
            ),
            Network::Regtest,
        )
        .script_pubkey(),
        Network::Regtest,
    )
    .unwrap()
}

fn preimage() -> [u8; 32] {
    let mut p = [0; 32];
    rand::thread_rng().fill_bytes(&mut p);
    p
}

fn segwit_input(refund: bool) -> InputDetail {
    let secp = Secp256k1::new();
    let claim = Keypair::new(&secp, &mut rand::thread_rng());
    let refund_keys = Keypair::new(&secp, &mut rand::thread_rng());
    let p = preimage();
    let timeout = (SHA.height().max(BLAKE.height()) + if refund { 1 } else { 100 }) as u32;
    let script = swap_script(
        hash160::Hash::hash(&p),
        &claim.public_key(),
        &refund_keys.public_key(),
        LockTime::from_height(timeout).unwrap(),
    );
    let (tx, vout) = fund_on_both(&Address::p2wsh(&script, Network::Regtest));
    InputDetail {
        input_type: if refund {
            InputType::Refund(timeout)
        } else {
            InputType::Claim(p)
        },
        output_type: OutputType::SegwitV0(script),
        outpoint: OutPoint::new(tx.compute_txid(), vout as u32),
        tx_out: tx.output[vout].clone(),
        keys: if refund { refund_keys } else { claim },
    }
}

fn taproot_input() -> InputDetail {
    let secp = Secp256k1::new();
    let claim = Keypair::new(&secp, &mut rand::thread_rng());
    let refund = Keypair::new(&secp, &mut rand::thread_rng());
    let internal = Keypair::new(&secp, &mut rand::thread_rng());
    let p = preimage();
    let tree = swap_tree(
        hash160::Hash::hash(&p),
        &claim.x_only_public_key().0,
        &refund.x_only_public_key().0,
        LockTime::from_height(SHA.height() as u32 + 100).unwrap(),
    );
    let spend = tree
        .build()
        .unwrap()
        .finalize(&secp, internal.x_only_public_key().0)
        .unwrap();
    let (tx, vout) = fund_on_both(&Address::p2tr_tweaked(spend.output_key(), Network::Regtest));
    InputDetail {
        input_type: InputType::Claim(p),
        output_type: OutputType::Taproot(Some(UncooperativeDetails {
            tree,
            internal_key: internal.x_only_public_key().0,
        })),
        outpoint: OutPoint::new(tx.compute_txid(), vout as u32),
        tx_out: tx.output[vout].clone(),
        keys: claim,
    }
}

fn build(input: InputDetail, mode: SighashMode) -> Transaction {
    let dest = destination();
    construct_tx_with_mode(
        &Secp256k1::new(),
        vec![input],
        &Destination::Single(&dest),
        FeeTarget::Absolute(2_000),
        mode,
    )
    .unwrap()
    .0
}

fn check_replay_protection(make: impl Fn() -> InputDetail) {
    assert_ne!(
        SHA.call("getblockhash", json!([FORK_HEIGHT])),
        BLAKE.call("getblockhash", json!([FORK_HEIGHT])),
        "chains did not split"
    );
    let input = make();

    let legacy = build(input.clone(), SighashMode::Legacy);
    assert_eq!(BLAKE.accept(&legacy)["allowed"], true, "legacy on BLAKE2b");
    assert_eq!(SHA.accept(&legacy)["allowed"], true, "legacy on SHA-256");

    let unified = build(input, SighashMode::Unified);
    assert_eq!(
        BLAKE.accept(&unified)["allowed"],
        true,
        "unified on BLAKE2b"
    );
    let on_sha = SHA.accept(&unified);
    assert_eq!(
        on_sha["allowed"], false,
        "unified must be rejected on SHA-256"
    );
    assert!(
        on_sha["reject-reason"]
            .as_str()
            .unwrap()
            .contains("script-verify-flag-failed"),
        "{on_sha}"
    );
}

#[test]
#[ignore]
fn p2wsh_claim_is_replay_protected() {
    check_replay_protection(|| segwit_input(false));
}

#[test]
#[ignore]
fn p2wsh_refund_is_replay_protected() {
    check_replay_protection(|| {
        let input = segwit_input(true);
        let InputType::Refund(timeout) = input.input_type else {
            unreachable!()
        };
        SHA.mine_to(timeout as u64);
        BLAKE.mine_to(timeout as u64);
        input
    });
}

#[test]
#[ignore]
fn taproot_script_claim_is_replay_protected() {
    check_replay_protection(taproot_input);
}

#[test]
#[ignore]
fn parses_both_chains_blocks_across_the_fork() {
    for (node, expect_v2) in [(&BLAKE, true), (&SHA, false)] {
        let tip = node.height().min(FORK_HEIGHT + 20);
        for height in FORK_HEIGHT - 3..=tip {
            let hash = node.call("getblockhash", json!([height]));
            let raw = node.call("getblock", json!([hash, 0]));
            let (header, txs) = parse_block(&hex::decode(raw.as_str().unwrap()).unwrap()).unwrap();
            assert_eq!(
                header.is_v2,
                expect_v2 && height >= FORK_HEIGHT,
                "height {height}"
            );
            assert_eq!(header.block_hash().to_string(), hash.as_str().unwrap());
            assert!(!txs.is_empty());
        }
    }
}
