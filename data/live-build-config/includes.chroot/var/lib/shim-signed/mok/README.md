# Secure Boot

## CA

Create Certificate Authority used for Kernel signing. CA is loaded into the
Machine Owner Key store on the target system.

```bash
openssl req -new -x509 -newkey rsa:4096 -keyout MOK.key -outform DER -out MOK.der -days 36500 -subj "/CN=VyOS Secure Boot CA/" -nodes
openssl x509 -inform der -in MOK.der -out MOK.pem
```
