// keyring-signer is a local, noninteractive adapter, never a network service.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	cryptocodec "github.com/cosmos/cosmos-sdk/crypto/codec"
	"github.com/cosmos/cosmos-sdk/crypto/keyring"
	"github.com/cosmos/cosmos-sdk/crypto/keys/secp256k1"
	cryptotypes "github.com/cosmos/cosmos-sdk/crypto/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/tx"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	"golang.org/x/sys/unix"
)

const maxRequestBytes = 64 * 1024
const operationTimeout = 15 * time.Second

type config struct {
	home, backend, key, expectedAddress, chainID string
}

type request struct {
	operation, signBytes, data string
}

type response struct {
	Address   string `json:"address"`
	PublicKey string `json:"publicKey"`
	Signature string `json:"signature,omitempty"`
}

type safeError string

func (e safeError) Error() string { return string(e) }

func parseFlags(args []string) (config, error) {
	var c config
	f := flag.NewFlagSet("keyring-signer", flag.ContinueOnError)
	f.SetOutput(io.Discard)
	f.StringVar(&c.home, "home", "", "existing manifestd home/keyring directory")
	f.StringVar(&c.backend, "keyring-backend", "", "existing keyring backend")
	f.StringVar(&c.key, "key", "", "existing key name")
	f.StringVar(&c.expectedAddress, "expected-address", "", "required wallet address")
	f.StringVar(&c.chainID, "chain-id", "", "required transaction chain")
	if f.Parse(args) != nil || f.NArg() != 0 {
		return c, safeError("INVALID_FLAGS")
	}
	if !filepath.IsAbs(c.home) || !regexp.MustCompile(`^[a-zA-Z0-9._-]{1,128}$`).MatchString(c.key) {
		return c, safeError("INVALID_CONFIGURATION")
	}
	if c.chainID != "manifest-ledger-mainnet" && c.chainID != "manifest-ledger-testnet" {
		return c, safeError("INVALID_CHAIN_CONFIGURATION")
	}
	switch c.backend {
	case "os", "file", "pass", "kwallet", "test", "memory":
	default:
		return c, safeError("UNSUPPORTED_BACKEND")
	}
	a, err := sdk.AccAddressFromBech32(c.expectedAddress)
	if err != nil || len(a) != 20 || a.String() != c.expectedAddress {
		return c, safeError("INVALID_EXPECTED_ADDRESS")
	}
	return c, nil
}

func readRequest(input io.Reader) (request, error) {
	var r request
	raw, err := io.ReadAll(io.LimitReader(input, maxRequestBytes+1))
	if err != nil {
		return r, safeError("REQUEST_READ_FAILED")
	}
	if len(raw) > maxRequestBytes {
		return r, safeError("REQUEST_TOO_LARGE")
	}
	if !utf8.Valid(raw) {
		return r, safeError("INVALID_REQUEST")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return r, safeError("INVALID_REQUEST")
	}
	seen := map[string]bool{}
	for d.More() {
		token, err := d.Token()
		name, ok := token.(string)
		if err != nil || !ok || seen[name] {
			return r, safeError("INVALID_REQUEST")
		}
		seen[name] = true
		var value json.RawMessage
		if d.Decode(&value) != nil || len(value) == 0 || value[0] != '"' {
			return r, safeError("INVALID_REQUEST")
		}
		var text string
		if json.Unmarshal(value, &text) != nil {
			return r, safeError("INVALID_REQUEST")
		}
		switch name {
		case "operation":
			r.operation = text
		case "signBytes":
			r.signBytes = text
		case "data":
			r.data = text
		default:
			return r, safeError("INVALID_REQUEST")
		}
	}
	if end, err := d.Token(); err != nil || end != json.Delim('}') {
		return r, safeError("INVALID_REQUEST")
	}
	if _, err := d.Token(); err != io.EOF {
		return r, safeError("INVALID_REQUEST")
	}
	switch r.operation {
	case "public-key":
		if len(seen) != 1 {
			return r, safeError("INVALID_REQUEST")
		}
	case "sign-direct":
		if len(seen) != 2 || !seen["signBytes"] {
			return r, safeError("INVALID_REQUEST")
		}
	case "sign-adr036":
		if len(seen) != 2 || !seen["data"] {
			return r, safeError("INVALID_REQUEST")
		}
	default:
		return r, safeError("UNSUPPORTED_OPERATION")
	}
	return r, nil
}

func directBytes(value, chainID string) ([]byte, error) {
	raw, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(raw) == 0 || base64.StdEncoding.EncodeToString(raw) != value {
		return nil, safeError("INVALID_SIGN_DOCUMENT")
	}
	var doc tx.SignDoc
	if doc.Unmarshal(raw) != nil || len(doc.BodyBytes) == 0 || len(doc.AuthInfoBytes) == 0 {
		return nil, safeError("INVALID_SIGN_DOCUMENT")
	}
	if doc.ChainId != chainID {
		return nil, safeError("CHAIN_MISMATCH")
	}
	// Reject duplicate/unknown protobuf fields and alternate encodings, ensuring
	// that the exact document inspected here is the one another decoder sees.
	canonical, err := doc.Marshal()
	if err != nil || !bytes.Equal(canonical, raw) {
		return nil, safeError("INVALID_SIGN_DOCUMENT")
	}
	var body tx.TxBody
	var auth tx.AuthInfo
	if body.Unmarshal(doc.BodyBytes) != nil || auth.Unmarshal(doc.AuthInfoBytes) != nil {
		return nil, safeError("INVALID_SIGN_DOCUMENT")
	}
	return raw, nil
}

func adr036Bytes(address, data string) ([]byte, error) {
	doc := map[string]any{
		"chain_id": "", "account_number": "0", "sequence": "0", "memo": "",
		"fee": map[string]any{"gas": "0", "amount": []any{}},
		"msgs": []any{map[string]any{"type": "sign/MsgSignData", "value": map[string]any{
			"signer": address, "data": base64.StdEncoding.EncodeToString([]byte(data)),
		}}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, safeError("SIGN_DOCUMENT_FAILED")
	}
	return sdk.MustSortJSON(raw), nil
}

type keyStore interface {
	Key(string) (*keyring.Record, error)
	Sign(string, []byte, signing.SignMode) ([]byte, cryptotypes.PubKey, error)
}

func signingBytes(c config, r request) ([]byte, signing.SignMode, error) {
	switch r.operation {
	case "public-key":
		return nil, signing.SignMode_SIGN_MODE_UNSPECIFIED, nil
	case "sign-direct":
		raw, err := directBytes(r.signBytes, c.chainID)
		return raw, signing.SignMode_SIGN_MODE_DIRECT, err
	case "sign-adr036":
		raw, err := adr036Bytes(c.expectedAddress, r.data)
		return raw, signing.SignMode_SIGN_MODE_LEGACY_AMINO_JSON, err
	default:
		return nil, 0, safeError("UNSUPPORTED_OPERATION")
	}
}

func handle(c config, r request, store keyStore) (response, error) {
	var out response
	// Validate the request before looking up any key.
	raw, mode, err := signingBytes(c, r)
	if err != nil {
		return out, err
	}
	record, err := store.Key(c.key)
	if err != nil || record == nil {
		return out, safeError("KEY_UNAVAILABLE_OR_LOCKED")
	}
	pub, err := record.GetPubKey()
	if err != nil {
		return out, safeError("INVALID_PUBLIC_KEY")
	}
	secp, ok := pub.(*secp256k1.PubKey)
	if !ok || len(secp.Bytes()) != 33 {
		return out, safeError("UNSUPPORTED_KEY_TYPE")
	}
	address := sdk.AccAddress(pub.Address()).String()
	if address != c.expectedAddress {
		return out, safeError("ADDRESS_MISMATCH")
	}
	out = response{Address: address, PublicKey: base64.StdEncoding.EncodeToString(pub.Bytes())}
	if r.operation == "public-key" {
		return out, nil
	}
	// An unattended helper cannot operate hardware or multisig/offline records.
	if record.GetLocal() == nil {
		return response{}, safeError("NONINTERACTIVE_SIGNING_UNAVAILABLE")
	}
	sig, signedPub, err := store.Sign(c.key, raw, mode)
	if err != nil {
		return response{}, safeError("SIGNING_FAILED")
	}
	if signedPub == nil || !signedPub.Equals(pub) || len(sig) != 64 || !pub.VerifySignature(raw, sig) {
		return response{}, safeError("SIGNATURE_VERIFICATION_FAILED")
	}
	out.Signature = base64.StdEncoding.EncodeToString(sig)
	return out, nil
}

func keyCodec() codec.Codec {
	registry := codectypes.NewInterfaceRegistry()
	cryptocodec.RegisterInterfaces(registry)
	return codec.NewProtoCodec(registry)
}

func run(args []string, input io.Reader) (response, error) {
	c, err := parseFlags(args)
	if err != nil {
		return response{}, err
	}
	r, err := readRequest(input)
	if err != nil {
		return response{}, err
	}
	if _, _, err := signingBytes(c, r); err != nil {
		return response{}, err
	}
	// Refuse to create a home or prompt for a passphrase. File backends always
	// require a passphrase, which this protocol intentionally cannot transport.
	if c.backend == "file" {
		return response{}, safeError("NONINTERACTIVE_UNLOCK_UNAVAILABLE")
	}
	if info, err := os.Stat(c.home); err != nil || !info.IsDir() {
		return response{}, safeError("KEYRING_HOME_UNAVAILABLE")
	}
	store, err := keyring.New("manifest", c.backend, c.home, bytes.NewReader(nil), keyCodec())
	if err != nil {
		return response{}, safeError("KEYRING_UNAVAILABLE_OR_LOCKED")
	}
	return handle(c, r, store)
}

func configureAddresses() {
	sdk.GetConfig().SetBech32PrefixForAccount("manifest", "manifestpub")
	sdk.GetConfig().Seal()
}

func disableCoreDumps() error {
	if syscall.Setrlimit(syscall.RLIMIT_CORE, &syscall.Rlimit{Cur: 0, Max: 0}) != nil {
		return safeError("CORE_DUMP_PROTECTION_FAILED")
	}
	// Linux ignores RLIMIT_CORE for piped collectors such as systemd-coredump.
	// Clearing dumpability also protects that configuration and ordinary ptrace.
	if unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0) != nil {
		return safeError("CORE_DUMP_PROTECTION_FAILED")
	}
	return nil
}

func main() {
	// A signing process may hold private material internally. Disable both core
	// limits before any keyring access, regardless of inherited shell settings.
	if err := disableCoreDumps(); err != nil {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]string{"error": string(err.(safeError))})
		os.Exit(1)
	}
	configureAddresses()
	// Libraries may print backend diagnostics. Keep those off the protocol and
	// emit only sanitized errors through separate descriptors. Redirect the OS
	// descriptors too, since a library may have captured stdout/stderr already.
	outFD, err := syscall.Dup(int(os.Stdout.Fd()))
	if err != nil {
		os.Exit(1)
	}
	errFD, err := syscall.Dup(int(os.Stderr.Fd()))
	if err != nil {
		os.Exit(1)
	}
	stdout := os.NewFile(uintptr(outFD), "protocol-stdout")
	stderr := os.NewFile(uintptr(errFD), "protocol-stderr")
	syscall.CloseOnExec(outFD)
	syscall.CloseOnExec(errFD)
	quiet, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil || syscall.Dup2(int(quiet.Fd()), 1) != nil || syscall.Dup2(int(quiet.Fd()), 2) != nil {
		_ = json.NewEncoder(stderr).Encode(map[string]string{"error": "OUTPUT_INITIALIZATION_FAILED"})
		os.Exit(1)
	}
	os.Stdout, os.Stderr = quiet, quiet
	type result struct {
		value response
		err   error
	}
	done := make(chan result, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- result{err: safeError("INTERNAL_ERROR")}
			}
		}()
		value, err := run(os.Args[1:], os.Stdin)
		done <- result{value, err}
	}()
	var completed result
	select {
	case completed = <-done:
	case <-time.After(operationTimeout):
		completed.err = safeError("KEYRING_OPERATION_TIMEOUT")
	}
	if completed.err != nil {
		code := safeError("INTERNAL_ERROR")
		_ = errors.As(completed.err, &code)
		_ = json.NewEncoder(stderr).Encode(map[string]string{"error": string(code)})
		os.Exit(1)
	}
	if json.NewEncoder(stdout).Encode(completed.value) != nil {
		os.Exit(1)
	}
}
