//! gRPC API over a UNIX socket (`/run/qfappd/qfappd.sock`).
//!
//! Read-only introspection for the WebUI and the qfagent cloud controller:
//! GetCatalog / GetPolicy / GetFlowStats / GetStatus. Serving is Linux-only
//! (tokio UnixListener); the service impl reads the shared daemon state.

use std::sync::Arc;

use tonic::{Request, Response, Status as RpcStatus};

use qfappd_proto::v1::{
    qfappd_server::{Qfappd, QfappdServer},
    AppFlowStat, Catalog as PbCatalog, CatalogApp, FlowStats, GetCatalogRequest,
    GetFlowStatsRequest, GetPolicyRequest, GetStatusRequest, PolicyAction, PolicyBinding,
    PolicyStatus, QueueStatus, Status as PbStatus,
};

use crate::daemon::SharedState;

pub struct Service {
    state: Arc<SharedState>,
}

impl Service {
    pub fn new(state: Arc<SharedState>) -> Self {
        Self { state }
    }
}

#[tonic::async_trait]
impl Qfappd for Service {
    async fn get_catalog(
        &self,
        _req: Request<GetCatalogRequest>,
    ) -> Result<Response<PbCatalog>, RpcStatus> {
        let c = &self.state.catalog;
        Ok(Response::new(PbCatalog {
            ndpi_version: c.ndpi_version.clone(),
            num_protocols: u32::from(c.num_protocols),
            applications: c
                .applications
                .iter()
                .map(|a| CatalogApp {
                    id: u32::from(a.id),
                    name: a.name.clone(),
                    category_id: u32::from(a.category_id),
                    category: a.category.clone(),
                })
                .collect(),
        }))
    }

    async fn get_policy(
        &self,
        _req: Request<GetPolicyRequest>,
    ) -> Result<Response<PolicyStatus>, RpcStatus> {
        let policy = self.state.policy.load();
        Ok(Response::new(PolicyStatus {
            generation: policy.generation,
            last_error: self.state.policy_last_error(),
            actions: policy
                .actions
                .iter()
                .map(|a| PolicyAction {
                    name: a.name.clone(),
                    action_id: u32::from(a.action_id),
                    default_action: verdict_str(a.default_action),
                    block_mode: block_mode_str(a.block_mode),
                })
                .collect(),
            bindings: policy
                .bindings
                .iter()
                .map(|b| PolicyBinding {
                    binding_id: b.binding_id,
                    action_id: u32::from(b.action_id),
                    action_name: b.action_name.clone(),
                    description: b.description.clone(),
                })
                .collect(),
            warnings: policy.warnings.clone(),
        }))
    }

    async fn get_flow_stats(
        &self,
        req: Request<GetFlowStatsRequest>,
    ) -> Result<Response<FlowStats>, RpcStatus> {
        let top_n = match req.into_inner().top_n {
            0 => 20,
            n => n as usize,
        };
        let merged = self.state.merged_stats();
        let catalog = self.state.catalog.clone();
        let top = merged.top_n(top_n, move |id| {
            catalog.app_name(id).unwrap_or("Unknown").to_string()
        });
        Ok(Response::new(FlowStats {
            total_decisions: merged.decisions,
            total_blocked: merged.blocked,
            total_unknown: merged.unknown,
            top_apps: top
                .into_iter()
                .map(|t| AppFlowStat {
                    app_id: u32::from(t.app_id),
                    app: t.app,
                    flows: t.stat.flows,
                    blocked_flows: t.stat.blocked_flows,
                    bytes: t.stat.bytes,
                    pkts: t.stat.pkts,
                })
                .collect(),
        }))
    }

    async fn get_status(
        &self,
        _req: Request<GetStatusRequest>,
    ) -> Result<Response<PbStatus>, RpcStatus> {
        Ok(Response::new(self.state.status_snapshot()))
    }
}

fn verdict_str(v: qfappd_core::policy::Verdict) -> String {
    match v {
        qfappd_core::policy::Verdict::Allow => "allow".into(),
        qfappd_core::policy::Verdict::Block => "block".into(),
    }
}

fn block_mode_str(m: qfappd_core::policy::BlockMode) -> String {
    match m {
        qfappd_core::policy::BlockMode::Drop => "drop".into(),
        qfappd_core::policy::BlockMode::Reset => "reset".into(),
    }
}

// Re-export the proto types the daemon needs to build a status snapshot.
pub use qfappd_proto::v1::Status as PbStatusMsg;
pub type QueueStatusMsg = QueueStatus;

/// Bind the UNIX socket and serve until `shutdown` resolves.
pub async fn serve(
    state: Arc<SharedState>,
    socket_path: std::path::PathBuf,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    use tokio::net::UnixListener;
    use tokio_stream::wrappers::UnixListenerStream;

    if socket_path.exists() {
        std::fs::remove_file(&socket_path).ok();
    }
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let listener = UnixListener::bind(&socket_path)?;
    // 0660: owner (qfappd) + group (the WebUI joins group qfappd) may connect.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o660)).ok();
    }
    let stream = UnixListenerStream::new(listener);

    tracing::info!("gRPC serving on {}", socket_path.display());
    tonic::transport::Server::builder()
        .add_service(QfappdServer::new(Service::new(state)))
        .serve_with_incoming_shutdown(stream, shutdown)
        .await?;
    Ok(())
}
