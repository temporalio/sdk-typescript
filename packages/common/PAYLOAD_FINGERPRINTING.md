# Payload Fingerprinting

This document captures a possible future design. It is not part of the External Storage payload
cache being shipped today.

## Context

Payload caching and payload identity are related but separate problems:

1. How does the SDK cache payloads without weakening codec protections?
2. How does the SDK recognize the same logical payload when its encoded bytes or storage location
   change?

A payload fingerprint would give the SDK a stable, portable identity for logical payload content.
That identity could support upload deduplication, cached downloads, decoded-value reuse, and other
optimizations across Clients, Workers, and Nexus boundaries.

## Decisions

### Fingerprint before payload codecs

The fingerprint identifies the `Payload` produced by the Payload Converter, before compression or
encryption codecs transform it. It covers converter-produced metadata and data because metadata
such as `json/plain`, `binary/plain`, or a Protobuf message type changes the meaning of the data.

This allows logically equivalent payloads to receive the same fingerprint even when a randomized
encryption codec produces different encoded bytes.

### Make fingerprint policy explicit

Fingerprinting is optional and pluggable. The SDK must not infer fingerprint policy from the
presence of payload codecs.

- No fingerprint provider means no fingerprinting.
- Plain SHA-256 is an explicit opt-in when equality disclosure is acceptable.
- HMAC-SHA-256 limits equality disclosure to parties holding the key.
- A custom provider allows users to define another policy or opt out for selected payloads.

Some users will not accept any content-derived value in history. The design must support disabling
fingerprinting entirely or declining individual payloads.

### Keep lifecycle keys and content identity separate

External Storage keys may remain scoped by namespace, Workflow, and run so drivers can delete
objects with prefix scans. A fingerprint identifies content and should not include Workflow ID,
run ID, or namespace.

Those keys serve different jobs:

- Storage keys describe ownership, location, and lifecycle.
- Fingerprints describe logical payload equality.

### Do not add structural salts

Namespace or Workflow salts prevent reuse across legitimate boundaries such as Nexus calls. For a
keyed fingerprint, the possession and distribution of the customer key defines the trust and dedup
scope. Cross-namespace key distribution should reuse the KMS/key-ID mechanism designed for Nexus
payload encryption rather than adding another path.

### Cache only encoded payloads

Payload caches must store post-codec encoded payloads. They must never store decoded or pre-codec
plaintext merely to improve reuse. This must remain true if an in-process cache is later replaced
with a shared network cache outside the SDK process.

A logical fingerprint and an encoded payload digest are different values:

- The logical fingerprint is computed before codecs and is stable across randomized encoding. It
  can be used as a cache key.
- An encoded payload digest is computed after codecs and verifies the exact bytes stored in a cache
  or External Storage. It cannot identify equivalent plaintext across randomized encoding.

### Carry fingerprints in the Payload envelope

The long-term wire model should add a first-class fingerprint field to the Payload envelope rather
than relying on feature-specific metadata or an SDK-only wrapper. The field must describe the
logical content represented by the envelope. It may need to include an opaque value, a scheme or
provider identifier, a version, and key metadata such as a KMS key ID.

Because existing payload codecs may return new payload objects and drop unknown fields, SDK
orchestration should preserve the fingerprint while codecs run and attach it to the final envelope.

### Verify at the correct stage

A cache maps a logical fingerprint to an encoded payload. A cached encoded payload cannot be
verified against the logical fingerprint until payload codecs decode it.

The eventual inbound flow is:

1. Read the fingerprint from the transported envelope or reference.
2. Look up the encoded payload in the cache.
3. Decode the cached payload through Payload Codecs.
4. Recompute or verify the logical fingerprint against the restored pre-codec payload.
5. On a cache mismatch, discard the cache result and fetch the authoritative encoded payload.
6. Decode and verify the authoritative payload. An authoritative mismatch is corruption and fails
   retrieval.

This fallback crosses the External Storage and codec layers and therefore belongs in a general
payload-processing pipeline, not inside an External Storage driver.

## Non-goals and related work

- Inline payload caching may avoid repeated codec decoding or deserialization, but it does not avoid
  a network fetch. It should be described separately from External Storage download caching.
- Payload fingerprinting does not replace payload memoization. Fingerprinting identifies equal
  payloads; memoization or payload handles address repeated payload representation and Workflow
  size.
- Fingerprints do not replace driver-specific hashes used for object naming, upload deduplication,
  or backend integrity checks.

## Open questions

- What is the provider interface and how does it batch payloads?
- What is the exact Payload wire schema for carrying fingerprints and key metadata?
- How are fingerprints preserved around existing codecs without changing every codec contract?
- Does the SDK standardize built-in SHA-256 and HMAC-SHA-256 providers?
- Where does cache fallback live once verification must happen after codec decoding?
- Is a separate encoded payload digest required for immediate cache and storage integrity checks?
