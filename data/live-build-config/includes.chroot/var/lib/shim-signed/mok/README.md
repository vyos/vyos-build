# Secure Boot

## CA

Create Certificate Authority used for Kernel signing. CA is loaded into the
Machine Owner Key store on the target system.

```bash
openssl req -new -x509 -newkey rsa:2048 -keyout MOK.key -outform DER -out MOK.der -days 36500 -subj "/CN=VyOS Secure Boot CA/" -nodes
openssl x509 -inform der -in MOK.der -out MOK.pem
```

## Kernel Module Signing Key

We do not make use of ephemeral keys for Kernel module signing. Instead a key
is generated and signed by the VyOS Secure Boot CA which signs all the Kernel
modules during ISO assembly if present.

```bash
openssl req -newkey rsa:2048 -keyout kernel.key -out kernel.csr -subj "/CN=VyOS Secure Boot Signer 2024 - linux/" -nodes
openssl x509 -req -in kernel.csr -CA MOK.pem -CAkey MOK.key -CAcreateserial -out kernel.pem -days 730 -sha256
```
