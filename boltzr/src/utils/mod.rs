pub mod bip21;
pub mod pair;
pub mod serde;
mod system;
mod timeout_map;
pub mod built_info {
    include!(concat!(env!("OUT_DIR"), "/built.rs"));
}

pub use system::available_parallelism;
pub use timeout_map::TimeoutMap;

/// SwapSha (StartOS package): the image builds from a copy of the repo with
/// no .git and passes the commit in SWAPSHA_COMMIT, which parseGitCommit.js
/// reads for the backend. Without it here the sidecar reported "3.13.0-" and
/// the backend refused it as incompatible.
fn commit_from_env() -> Option<&'static str> {
    option_env!("SWAPSHA_COMMIT").filter(|commit| !commit.is_empty())
}

pub fn get_version() -> String {
    let from_env = commit_from_env();
    format!(
        "{}-{}{}",
        built_info::PKG_VERSION,
        from_env
            .or(built_info::GIT_COMMIT_HASH)
            .unwrap_or("")
            .chars()
            .take(8)
            .collect::<String>(),
        if from_env.is_none() && built_info::GIT_DIRTY.unwrap_or(false) {
            "-dirty"
        } else {
            ""
        }
    )
}

#[cfg(any(feature = "loki", feature = "otel"))]
pub fn get_name(network: &str) -> String {
    format!("boltz-backend-{}-{}", network, built_info::PKG_NAME)
}

#[cfg(any(feature = "loki", feature = "otel"))]
pub fn get_network(network: &Option<String>) -> String {
    network.clone().unwrap_or("regtest".to_string())
}

#[cfg(test)]
mod utils_test {
    use crate::utils::*;

    #[test]
    fn test_get_version() {
        let version = get_version();
        let split: Vec<&str> = version.split('-').collect();
        // For compatibility with the backend
        assert_eq!(split[1].to_string().len(), 8);
    }

    #[test]
    fn test_get_version_takes_the_commit_from_swapsha_commit() {
        let version = get_version();
        match commit_from_env() {
            // Built with SWAPSHA_COMMIT, as in the StartOS image
            Some(commit) => assert_eq!(
                version,
                format!(
                    "{}-{}",
                    built_info::PKG_VERSION,
                    commit.chars().take(8).collect::<String>()
                )
            ),
            // Built in a git checkout
            None => assert_eq!(
                version.split('-').nth(1).map(str::len),
                built_info::GIT_COMMIT_HASH.map(|_| 8)
            ),
        }
    }

    #[test]
    fn test_get_name() {
        assert_eq!(get_name("regtest"), "boltz-backend-regtest-boltzr");
    }

    #[test]
    fn test_get_network() {
        assert_eq!(
            get_network(&Some("mainnet".to_string())),
            "mainnet".to_string()
        );
        assert_eq!(
            get_network(&Some("testnet".to_string())),
            "testnet".to_string()
        );
        assert_eq!(get_network(&None), "regtest".to_string());
    }
}
