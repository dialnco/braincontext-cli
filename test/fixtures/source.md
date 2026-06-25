# OAuth2 at the edge

Notes ingested as a raw source for the wiki demo.

- The Gateway service terminates TLS and validates JWTs before proxying.
- OAuth2 authorization-code flow issues short-lived access tokens.
- Token introspection happens at the Gateway, not in each backend.
