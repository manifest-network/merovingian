package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/cosmos/cosmos-sdk/crypto/hd"
	"github.com/cosmos/cosmos-sdk/crypto/keyring"
	"github.com/cosmos/cosmos-sdk/crypto/keys/ed25519"
	cryptotypes "github.com/cosmos/cosmos-sdk/crypto/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/tx"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"golang.org/x/sys/unix"
)

// Widely published BIP-39 test vector; never use it for real assets.
const fixtureMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

func TestMain(m *testing.M) {
	configureAddresses()
	os.Exit(m.Run())
}

func fixture(t *testing.T) (config, keyring.Keyring) {
	t.Helper()
	store := keyring.NewInMemory(keyCodec())
	record, err := store.NewAccount("fixture", fixtureMnemonic, "", "m/44'/118'/0'/0/0", hd.Secp256k1)
	if err != nil {
		t.Fatal(err)
	}
	address, err := record.GetAddress()
	if err != nil {
		t.Fatal(err)
	}
	return config{home: t.TempDir(), backend: "memory", key: "fixture", expectedAddress: address.String(), chainID: "manifest-ledger-testnet"}, store
}

func directFixture(t *testing.T, chain string) []byte {
	t.Helper()
	body, err := (&tx.TxBody{Memo: "public signing test"}).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	auth, err := (&tx.AuthInfo{Fee: &tx.Fee{GasLimit: 120000}}).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := (&tx.SignDoc{BodyBytes: body, AuthInfoBytes: auth, ChainId: chain, AccountNumber: 7}).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// Verify with Go's ECDSA implementation, independently of keyring.Sign and
// Cosmos PubKey.VerifySignature; secp256k1 is only used for curve arithmetic.
func verifySignature(t *testing.T, out response, raw []byte) {
	t.Helper()
	pubBytes, err := base64.StdEncoding.DecodeString(out.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := secp.ParsePubKey(pubBytes)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := base64.StdEncoding.DecodeString(out.Signature)
	if err != nil || len(sig) != 64 {
		t.Fatal("invalid signature encoding")
	}
	digest := sha256.Sum256(raw)
	if !ecdsa.Verify(pub.ToECDSA(), digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("independent signature verification failed")
	}
	digest[0] ^= 1
	if ecdsa.Verify(pub.ToECDSA(), digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("signature accepted different message")
	}
}

func TestDirectAndPublicKey(t *testing.T) {
	c, store := fixture(t)
	public, err := handle(c, request{operation: "public-key"}, store)
	if err != nil || public.Address != c.expectedAddress || public.Signature != "" {
		t.Fatalf("public-key: %v", err)
	}
	raw := directFixture(t, c.chainID)
	signed, err := handle(c, request{operation: "sign-direct", signBytes: base64.StdEncoding.EncodeToString(raw)}, store)
	if err != nil {
		t.Fatal(err)
	}
	if signed.Address != public.Address || signed.PublicKey != public.PublicKey {
		t.Fatal("identity changed")
	}
	verifySignature(t, signed, raw)
}

func TestADR036CanonicalEnvelopeAndSignature(t *testing.T) {
	c, store := fixture(t)
	data := "merovingian:public-fixture:☕ <&>\n"
	raw, err := adr036Bytes(c.expectedAddress, data)
	if err != nil {
		t.Fatal(err)
	}
	expected := fmt.Sprintf(`{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"","msgs":[{"type":"sign/MsgSignData","value":{"data":"%s","signer":"%s"}}],"sequence":"0"}`, base64.StdEncoding.EncodeToString([]byte(data)), c.expectedAddress)
	if string(raw) != expected {
		t.Fatal("ADR-036 envelope differs from canonical Amino")
	}
	out, err := handle(c, request{operation: "sign-adr036", data: data}, store)
	if err != nil {
		t.Fatal(err)
	}
	verifySignature(t, out, []byte(expected))
}

type observedStore struct {
	keyStore
	lookups, signatures int
	mode                signing.SignMode
}

func (s *observedStore) Key(name string) (*keyring.Record, error) {
	s.lookups++
	return s.keyStore.Key(name)
}

func (s *observedStore) Sign(name string, raw []byte, mode signing.SignMode) ([]byte, cryptotypes.PubKey, error) {
	s.signatures++
	s.mode = mode
	return s.keyStore.Sign(name, raw, mode)
}

func TestAddressAndChainBindingBeforeSigning(t *testing.T) {
	c, memory := fixture(t)
	store := &observedStore{keyStore: memory}
	c.expectedAddress = sdk.AccAddress(bytes.Repeat([]byte{9}, 20)).String()
	if _, err := handle(c, request{operation: "sign-adr036", data: "message"}, store); err != safeError("ADDRESS_MISMATCH") {
		t.Fatalf("address error: %v", err)
	}
	if store.signatures != 0 {
		t.Fatal("signed for mismatched address")
	}
	store.lookups = 0
	raw := directFixture(t, "manifest-ledger-mainnet")
	if _, err := handle(c, request{operation: "sign-direct", signBytes: base64.StdEncoding.EncodeToString(raw)}, store); err != safeError("CHAIN_MISMATCH") {
		t.Fatalf("chain error: %v", err)
	}
	if store.lookups != 0 || store.signatures != 0 {
		t.Fatal("wrong-chain request reached keyring")
	}
}

func TestSigningModeSelection(t *testing.T) {
	c, memory := fixture(t)
	store := &observedStore{keyStore: memory}
	if _, err := handle(c, request{operation: "sign-adr036", data: "test"}, store); err != nil {
		t.Fatal(err)
	}
	if store.mode != signing.SignMode_SIGN_MODE_LEGACY_AMINO_JSON {
		t.Fatal("wrong ADR signing mode")
	}
	if _, err := handle(c, request{operation: "sign-direct", signBytes: base64.StdEncoding.EncodeToString(directFixture(t, c.chainID))}, store); err != nil {
		t.Fatal(err)
	}
	if store.mode != signing.SignMode_SIGN_MODE_DIRECT {
		t.Fatal("wrong direct signing mode")
	}
}

func TestMalformedDirectDocuments(t *testing.T) {
	c, _ := fixture(t)
	raw := directFixture(t, c.chainID)
	blank, err := (&tx.SignDoc{ChainId: c.chainID}).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	badInner, err := (&tx.SignDoc{ChainId: c.chainID, BodyBytes: []byte{255}, AuthInfoBytes: []byte{255}}).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	for name, encoded := range map[string]string{
		"empty": "", "bad-base64": "###", "empty-parts": base64.StdEncoding.EncodeToString(blank),
		"invalid-inner-proto": base64.StdEncoding.EncodeToString(badInner),
		"unknown-field":       base64.StdEncoding.EncodeToString(append(append([]byte{}, raw...), 0x28, 1)),
		"duplicate-chain":     base64.StdEncoding.EncodeToString(append(append([]byte{}, raw...), append([]byte{0x1a, byte(len(c.chainID))}, []byte(c.chainID)...)...)),
		"base64-newline":      base64.StdEncoding.EncodeToString(raw) + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := directBytes(encoded, c.chainID); err != safeError("INVALID_SIGN_DOCUMENT") {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestStrictBoundedRequests(t *testing.T) {
	for name, value := range map[string]string{
		"unknown":            `{"operation":"public-key","secret":"do-not-echo"}`,
		"duplicate":          `{"operation":"public-key","operation":"sign-direct"}`,
		"trailing":           `{"operation":"public-key"} {}`,
		"missing-data":       `{"operation":"sign-adr036"}`,
		"wrong-data-type":    `{"operation":"sign-adr036","data":null}`,
		"cross-operation":    `{"operation":"sign-adr036","signBytes":"abc"}`,
		"extra-public-field": `{"operation":"public-key","data":""}`,
		"not-object":         `[]`, "null": `null`, "broken": `{`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := readRequest(strings.NewReader(value)); err != safeError("INVALID_REQUEST") {
				t.Fatalf("got %v", err)
			}
		})
	}
	if _, err := readRequest(strings.NewReader(strings.Repeat(" ", maxRequestBytes+1))); err != safeError("REQUEST_TOO_LARGE") {
		t.Fatalf("oversize: %v", err)
	}
	if _, err := readRequest(strings.NewReader(`{"operation":"export"}`)); err != safeError("UNSUPPORTED_OPERATION") {
		t.Fatalf("operation: %v", err)
	}
	for _, value := range []string{`{"operation":"public-key"}`, `{"operation":"sign-adr036","data":""}`, `{"operation":"sign-direct","signBytes":"abc"}`} {
		if _, err := readRequest(strings.NewReader(value)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUnavailableAndUnsupportedKeys(t *testing.T) {
	c, store := fixture(t)
	c.key = "missing"
	if _, err := handle(c, request{operation: "public-key"}, store); err != safeError("KEY_UNAVAILABLE_OR_LOCKED") {
		t.Fatal(err)
	}
	if _, err := store.SaveOfflineKey("ed", ed25519.GenPrivKey().PubKey()); err != nil {
		t.Fatal(err)
	}
	c.key = "ed"
	if _, err := handle(c, request{operation: "public-key"}, store); err != safeError("UNSUPPORTED_KEY_TYPE") {
		t.Fatal(err)
	}
	record, err := store.Key("fixture")
	if err != nil {
		t.Fatal(err)
	}
	pub, err := record.GetPubKey()
	if err != nil {
		t.Fatal(err)
	}
	offline := keyring.NewInMemory(keyCodec())
	if _, err := offline.SaveOfflineKey("fixture", pub); err != nil {
		t.Fatal(err)
	}
	c.key = "fixture"
	if _, err := handle(c, request{operation: "sign-adr036", data: "test"}, offline); err != safeError("NONINTERACTIVE_SIGNING_UNAVAILABLE") {
		t.Fatal(err)
	}
}

func fixtureFlags(c config) []string {
	return []string{"--home", c.home, "--keyring-backend", c.backend, "--key", c.key, "--expected-address", c.expectedAddress, "--chain-id", c.chainID}
}

func TestRequiredFlagsAndNoninteractiveFileBackend(t *testing.T) {
	c, _ := fixture(t)
	args := fixtureFlags(c)
	if _, err := parseFlags(args); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < len(args); i += 2 {
		missing := append(append([]string{}, args[:i]...), args[i+2:]...)
		if _, err := parseFlags(missing); err == nil {
			t.Fatalf("accepted missing %s", args[i])
		}
	}
	if _, err := parseFlags(append(args, "extra")); err == nil {
		t.Fatal("accepted trailing argument")
	}
	c.backend = "file"
	if _, err := run(fixtureFlags(c), strings.NewReader(`{"operation":"public-key"}`)); err != safeError("NONINTERACTIVE_UNLOCK_UNAVAILABLE") {
		t.Fatal(err)
	}
}

func TestCoreDumpsDisabledInIsolatedProcess(t *testing.T) {
	if os.Getenv("KEYRING_SIGNER_CORE_LIMIT_CHILD") == "1" {
		if err := disableCoreDumps(); err != nil {
			t.Fatal(err)
		}
		var limit syscall.Rlimit
		if err := syscall.Getrlimit(syscall.RLIMIT_CORE, &limit); err != nil {
			t.Fatal(err)
		}
		if limit.Cur != 0 || limit.Max != 0 {
			t.Fatal("core dumps remain enabled")
		}
		dumpable, err := unix.PrctlRetInt(unix.PR_GET_DUMPABLE, 0, 0, 0, 0)
		if err != nil || dumpable != 0 {
			t.Fatal("process remains dumpable")
		}
		return
	}
	var before, after syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_CORE, &before); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestCoreDumpsDisabledInIsolatedProcess$", "-test.count=1")
	child.Env = append(os.Environ(), "KEYRING_SIGNER_CORE_LIMIT_CHILD=1")
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("isolated core protection test failed: %v: %s", err, output)
	}
	if err := syscall.Getrlimit(syscall.RLIMIT_CORE, &after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("child altered parent core limits")
	}
}

// Opt-in integration fixture export: a PUBLIC test vector in the insecure test
// backend, created only in a brand-new directory. Never touches a real keyring.
func TestWritePublicFixture(t *testing.T) {
	directory := os.Getenv("KEYRING_SIGNER_TEST_FIXTURE_DIR")
	if directory == "" {
		t.Skip("no public integration fixture requested")
	}
	if !filepath.IsAbs(directory) {
		t.Fatal("fixture directory must be absolute")
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal("fixture directory must not already exist")
	}
	store, err := keyring.New("manifest", "test", directory, bytes.NewReader(nil), keyCodec())
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.NewAccount("fixture", fixtureMnemonic, "", "m/44'/118'/0'/0/0", hd.Secp256k1)
	if err != nil {
		t.Fatal(err)
	}
	address, err := record.GetAddress()
	if err != nil {
		t.Fatal(err)
	}
	pub, err := record.GetPubKey()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(response{Address: address.String(), PublicKey: base64.StdEncoding.EncodeToString(pub.Bytes())})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "public.json"), append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}
