use serde::{Deserialize, Serialize, Serializer};
use std::fmt::Display;
use std::str::FromStr;

#[derive(PartialEq, Debug, Clone, Copy)]
pub enum Type {
    Bitcoin,
    Elements,
}

impl FromStr for Type {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "BTC" => Ok(Type::Bitcoin),
            "L-BTC" => Ok(Type::Elements),
            _ => Err(anyhow::anyhow!("unknown symbol {}", s)),
        }
    }
}
impl Display for Type {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub enum RpcParam<'a> {
    Str(&'a str),
    Int(i64),
    Float(f64),
    /// SwapSha D38: `gettxout` takes include_mempool as a JSON bool
    Bool(bool),
    Null,
}

impl Serialize for RpcParam<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match *self {
            RpcParam::Str(s) => serializer.serialize_str(s),
            RpcParam::Int(num) => serializer.serialize_i64(num),
            RpcParam::Float(num) => serializer.serialize_f64(num),
            RpcParam::Bool(b) => serializer.serialize_bool(b),
            RpcParam::Null => serializer.serialize_none(),
        }
    }
}

#[derive(Serialize)]
pub struct RpcRequest<'a> {
    pub method: &'a str,
    /// SwapSha: always sent, `[]` when there are none. btc-rpc-proxy (the
    /// SHA-256 Companion's RPC port on StartOS) refuses a request without
    /// params, and a `null` one; bitcoind takes all three.
    #[serde(serialize_with = "params_or_empty")]
    pub params: Option<&'a [RpcParam<'a>]>,
}

fn params_or_empty<S: Serializer>(
    params: &Option<&[RpcParam<'_>]>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    params.unwrap_or(&[]).serialize(serializer)
}

#[derive(Deserialize, Debug)]
pub struct RpcError {
    pub message: String,
}

#[derive(Deserialize, Debug)]
pub struct RpcResponse<T>
where
    T: std::fmt::Debug,
{
    pub result: Option<T>,
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NetworkInfo {
    pub subversion: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlockchainInfo {
    pub blocks: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SmartFeeEstimate {
    pub feerate: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ZmqNotification {
    #[serde(rename = "type")]
    pub notification_type: String,
    pub address: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawTransactionVerbose {
    pub hex: String,
    pub confirmations: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BlockInfo {
    pub height: u64,
}

impl RawTransactionVerbose {
    pub fn is_confirmed(&self) -> bool {
        match self.confirmations {
            Some(confirmations) => confirmations > 0,
            None => false,
        }
    }
}

pub type RawMempool = Vec<String>;

#[derive(Debug, Clone, Deserialize)]
pub struct UnspentOutput {
    pub txid: String,
    pub vout: u32,
    pub address: String,
    pub amount: f64,

    /// Only set for Liquid
    pub asset: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignRawTransactionResponse {
    pub hex: String,
    pub complete: bool,
}

#[cfg(test)]
mod rpc_request_test {
    use super::*;

    #[test]
    fn test_rpc_request_always_sends_params() {
        assert_eq!(
            serde_json::to_string(&RpcRequest {
                method: "getblockchaininfo",
                params: None,
            })
            .unwrap(),
            r#"{"method":"getblockchaininfo","params":[]}"#
        );
        assert_eq!(
            serde_json::to_string(&RpcRequest {
                method: "getblockhash",
                params: Some(&[RpcParam::Int(1)]),
            })
            .unwrap(),
            r#"{"method":"getblockhash","params":[1]}"#
        );
    }
}
