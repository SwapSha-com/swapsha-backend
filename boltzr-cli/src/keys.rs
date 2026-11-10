//! SwapSha D44 (amended Nov 9): the key of a swap from `seed.dat`, offline,
//! so the operator can sign a refund or a claim with `tx refund` or
//! `tx claim` while SwapSha is stopped.
//!
//! The same derivation as the backend's WalletManager and the sidecar's
//! `wallet::keys`: the BIP39 seed with no passphrase, its BIP32 master key,
//! then the path the rescue file gives for the swap (the currency's
//! derivation path followed by the swap's key index, such as `m/0/1/5`).

use ::serde::Serialize;
use anyhow::{Context, Result};
use bip39::Mnemonic;
use bitcoin::NetworkKind;
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::key::Secp256k1;
use std::fs;
use std::path::Path;
use std::str::FromStr;

#[derive(Debug, PartialEq, Serialize)]
pub struct DerivedKey {
    pub path: String,
    pub public_key: String,
    pub private_key: String,
}

pub fn derive_from_phrase(phrase: &str, path: &str) -> Result<DerivedKey> {
    let seed = Mnemonic::from_str(phrase.trim())
        .context("the file does not hold a BIP39 mnemonic")?
        .to_seed("");
    let path = path.trim();
    let derivation_path =
        DerivationPath::from_str(path).with_context(|| format!("not a derivation path: {path}"))?;

    let secp = Secp256k1::new();
    let key = Xpriv::new_master(NetworkKind::Main, &seed)?.derive_priv(&secp, &derivation_path)?;

    Ok(DerivedKey {
        path: path.to_string(),
        public_key: key.private_key.public_key(&secp).to_string(),
        private_key: alloy::hex::encode(key.private_key.secret_bytes()),
    })
}

pub fn derive(mnemonic_file: &Path, path: &str) -> Result<DerivedKey> {
    let phrase = fs::read_to_string(mnemonic_file)
        .with_context(|| format!("could not read {}", mnemonic_file.display()))?;
    derive_from_phrase(&phrase, path)
}

#[cfg(test)]
mod test {
    use super::*;
    use rstest::rstest;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    // Expected keys from the backend's own libraries, @scure/bip39
    // mnemonicToSeedSync and @scure/bip32 HDKey.fromMasterSeed(seed).derive(path),
    // as WalletManager uses them
    #[rstest]
    #[case(
        "m/0/0/1",
        "731573db19bfd58d896e982ca68728ed927197757b93f2fd40d26129c7184512",
        "0350d801e5faf5cc96dc275996ab4e9fd88e52e32c95f3989b9349cce704ea41e6"
    )]
    #[case(
        "m/0/1/42",
        "476fd293c4f49e8d97b15935d158bf0c76f1088ff30d264d64e7990bd00b9058",
        "02985d876d7fcdfc33c642c5f72d58148fc504130f67a8a90758ab19f24615b394"
    )]
    #[case(
        "m/0/2/0",
        "d217687760876dc0292d02f85bf1526665b635a051110ded1f167ebf72bcddb1",
        "02e2dfbbf88abe331126be29f7cd493982b73f0d652ee4f5b82169ed544dbf95c4"
    )]
    fn derives_like_the_backend(
        #[case] path: &str,
        #[case] private_key: &str,
        #[case] public_key: &str,
    ) {
        assert_eq!(
            derive_from_phrase(PHRASE, path).unwrap(),
            DerivedKey {
                path: path.to_string(),
                public_key: public_key.to_string(),
                private_key: private_key.to_string(),
            }
        );
    }

    #[test]
    fn reads_a_mnemonic_file_with_a_trailing_newline() {
        let dir = std::env::temp_dir().join(format!("swapsha-keys-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("seed.dat");
        fs::write(&file, format!("{PHRASE}\n")).unwrap();

        assert_eq!(
            derive(&file, " m/0/1/42\n").unwrap().private_key,
            "476fd293c4f49e8d97b15935d158bf0c76f1088ff30d264d64e7990bd00b9058"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_what_is_not_a_mnemonic_or_a_path() {
        assert!(derive_from_phrase("not a mnemonic", "m/0/0/1").is_err());
        assert!(derive_from_phrase(PHRASE, "m/zero").is_err());
        assert!(derive(Path::new("/nonexistent/seed.dat"), "m/0/0/1").is_err());
    }
}
