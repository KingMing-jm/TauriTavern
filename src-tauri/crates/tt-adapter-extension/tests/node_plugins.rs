//! Real Node/SQLite acceptance. Preparation is explicit, never a test-time network download.
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};
use tt_adapter_extension::node_plugins::NodePluginProcess;
use tt_contracts::node_plugins::PluginRequest;
use tt_ports::node_plugins::NodePluginRuntime;

async fn call(host: &NodePluginProcess, method: &str, endpoint: &str, body: Value) -> (u16, Value) {
    let response = host
        .request(PluginRequest {
            method: method.into(),
            path: format!("/api/plugins/baibaoku/{endpoint}"),
            headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
            body: if body.is_null() {
                vec![]
            } else {
                serde_json::to_vec(&body).unwrap()
            },
        })
        .await
        .unwrap();
    (
        response.status,
        serde_json::from_slice(&response.body).unwrap(),
    )
}

#[tokio::test]
#[ignore = "requires TT_NODE_PLUGIN_RUNTIME prepared by scripts/node-plugins/prepare.mjs and TT_NODE_BINARY"]
async fn real_baibaoku_persists_and_restarts_through_rust_host() {
    let runtime =
        PathBuf::from(std::env::var("TT_NODE_PLUGIN_RUNTIME").expect("TT_NODE_PLUGIN_RUNTIME"));
    let node = PathBuf::from(std::env::var("TT_NODE_BINARY").expect("TT_NODE_BINARY"));
    let data = std::env::temp_dir().join(format!("tt-node-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(data.join("_tauritavern"))
        .await
        .unwrap();
    tokio::fs::create_dir_all(data.join("default-user"))
        .await
        .unwrap();
    let host = NodePluginProcess::new(data.clone(), true).unwrap();
    assert_eq!(host.status().await.unwrap().state, "disabled");
    tokio::fs::write(
        data.join("_tauritavern/node-plugins.json"),
        serde_json::to_vec(&json!({"node":node,"runtime":runtime})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(host.start().await.unwrap().plugins, ["baibaoku"]);
    let (status, payload) = call(&host, "GET", "v1/status", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(payload["data"]["driver"]["available"], true);
    assert_eq!(payload["data"]["capabilities"]["stEndpoints"], false);
    let (status, _) = call(
        &host,
        "POST",
        "v1/set-many",
        json!({
            "database":"validation", "store":"items", "entries":[
                {"key":"one", "value":{"message":"柏宝库 real SQLite"}},
                {"key":"two", "value":[1,2,3]}
            ],
        }),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = call(&host, "POST", "v1/chats/save-generate", json!({})).await;
    assert_eq!(status, 501);
    host.stop().await.unwrap();
    assert_eq!(host.status().await.unwrap().state, "stopped");
    assert!(
        host.request(PluginRequest {
            method: "GET".into(),
            path: "/api/plugins/baibaoku/v1/status".into(),
            headers: BTreeMap::new(),
            body: vec![]
        })
        .await
        .is_err()
    );
    host.start().await.unwrap();
    let (status, payload) = call(
        &host,
        "POST",
        "v1/get",
        json!({"database":"validation","store":"items","key":"one"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(payload["data"]["value"]["message"], "柏宝库 real SQLite");
    let (status, _) = call(
        &host,
        "POST",
        "v1/set",
        json!({"database":"../escape","store":"items","key":"bad","value":1}),
    )
    .await;
    assert_eq!(status, 400);
    host.stop().await.unwrap();
    assert!(
        tokio::fs::metadata(data.join("default-user/baibaoku/databases/validation.sqlite"))
            .await
            .unwrap()
            .len()
            > 0
    );
    drop(host);
    tokio::fs::remove_dir_all(data).await.unwrap();
}
