system {
    host-name vyos
    login {
        user vyos {
            authentication {
                encrypted-password $6$QxPS.uk6mfo$9QBSo8u1FkH16gMyAVhus6fU3LOzvLR9Z9.82m3tiHFAxTtIkhaZSWssSgzt4v4dGAL8rhVQxTg0oAG9/q11h/
                plaintext-password ""
            }
        }
    }
    syslog {
        global {
            facility all {
                level info
            }
            facility protocols {
                level debug
            }
        }
    }
    ntp {
        allow-client {
            address 127.0.0.0/8
            address 169.254.0.0/16
            address 10.0.0.0/8
            address 172.16.0.0/12
            address 192.168.0.0/16
            address ::1/128
            address fe80::/10
            address fc00::/7
        }
        server "time1.vyos.net"
        server "time2.vyos.net"
        server "time3.vyos.net"
    }
    console {
        device ttyS0 {
            speed 115200
        }
    }
    config-management {
        commit-revisions 100
    }
}

interfaces {
    loopback lo {
    }
}
