fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_client(true)
        .build_server(true)
        .compile(&["../../proto/qfappd/v1/qfappd.proto"], &["../../proto"])?;
    Ok(())
}
