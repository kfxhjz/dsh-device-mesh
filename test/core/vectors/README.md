# Noise test vectors

`noise-nk.json` holds the official [noise-c](https://github.com/rweather/noise-c)
test vectors (`tests/vector/noise-c-basic.txt`, branch `master`, retrieved
2026-11-09) for:

- `Noise_NK_25519_ChaChaPoly_SHA256`
- `NoisePSK_NK_25519_ChaChaPoly_SHA256` (NKpsk0, noise-c "NoisePSK" convention)

The data is copied verbatim (hex strings) and is MIT licensed:
Copyright (C) 2016 Southern Storm Software, Pty Ltd.

Only these two vectors are vendored so the test suite stays small and fully
offline. `docs/PROTOCOL.md` §4.5 requires byte-for-byte verification of msg1 /
msg2 against these vectors; `test/core/noise.test.ts` also decrypts the
recorded transport messages (entries 3-6) with the derived tx/rx CipherStates.

Note: production dsh-mesh uses `Noise_NK_25519_ChaChaPoly_SHA256` with
prologue `dsh-mesh/1` (no PSK). PSK support exists only so the NKpsk0 vector
can be checked; it follows noise-c's historical PSK mixing order.
