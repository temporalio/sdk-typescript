#!/bin/bash

rm -rf test-*.{crt,key,csr,srl}


# Create a self-signed root CA

openssl req \
    -newkey rsa:4096 -nodes -keyout test-ca.key \
    -new -x509 -days 3650 -out test-ca.crt \
    -subj "/C=US/ST=WA/CN=Test Root CA - DO NOT TRUST" \
    -addext basicConstraints=critical,CA:TRUE \


# Create the server certificate

openssl req \
    -newkey rsa:2048 -nodes -keyout test-server.key \
    -new -x509 -days 3650 -out test-server.crt \
    -subj "/CN=server" \
    -CA test-ca.crt -CAkey test-ca.key \
    -extensions v3_ca -addext "basicConstraints = CA:FALSE" \
    -addext "subjectAltName = IP:127.0.0.1,DNS:localhost,DNS:server"

cat test-server.crt test-ca.crt > test-server-chain.crt


# Create the client certificate

openssl req \
    -newkey rsa:2048 -nodes -keyout test-client.key \
    -new -x509 -days 3650 -out test-client.crt \
    -subj "/CN=client" \
    -CA test-ca.crt -CAkey test-ca.key \
    -extensions v3_ca -addext "basicConstraints = CA:FALSE" \
    -addext "subjectAltName = IP:127.0.0.1,DNS:localhost,DNS:client"

cat test-client.crt test-ca.crt > test-client-chain.crt


# Delete files we don't need, to avoid confusion. Also delete the CA's key to discourage reuse of this
# unsafe CA for anything else. Anyway, one can simply rerun this script to create a new CA if needed.

rm -rf test-ca.key test-client.crt test-server.crt
