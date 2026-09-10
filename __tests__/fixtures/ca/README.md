# Test-only TLS fixtures

These public, disposable private keys and certificates are **only** for loopback tests, never deployment.

- `server-key.pem`: unencrypted RSA test key.
- `server.pem`: self-signed CA/server certificate, SAN `localhost` and `127.0.0.1`, valid for ten years from generation (September 2026).
- `wrong.pem`: unrelated self-signed root (its private key is not needed).
- `hostname.pem`: self-signed certificate using the server key, but CN `wrong.example`, deliberately not matching loopback.
- `expired.pem`: certificate using the server key, signed by `server.pem`, with loopback SANs and validity January 2020–January 2021.

Generated using OpenSSL `req -x509 -newkey rsa:2048 -nodes -days 3650` (or `-key server-key.pem`), with `-addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'` for the valid certificate. The expired leaf was signed using `openssl ca -startdate 20200101000000Z -enddate 20210101000000Z` and the same loopback SAN extension. Regenerate valid fixtures before September 2036.
