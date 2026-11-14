package missionanchors

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func load(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "vectors", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	v, err := ParseStrict(raw)
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	return v.(map[string]any)
}

// TestAppendixD reproduces each Appendix D vector: the canonical bytes of the
// envelope as the draft prints them, and the anchor.
func TestAppendixD(t *testing.T) {
	doc := load(t, "appendix-d-integrity-anchors.json")
	vectors := doc["vectors"].([]any)
	if len(vectors) != 6 {
		t.Fatalf("want the 6 vectors of Appendix D, have %d", len(vectors))
	}
	for _, raw := range vectors {
		v := raw.(map[string]any)
		name := v["name"].(string)
		t.Run(name, func(t *testing.T) {
			typ, iss := v["typ"].(string), v["iss"].(string)
			digest, canonical, err := Compute(typ, iss, v["value"])
			if err != nil {
				t.Fatal(err)
			}
			if string(canonical) != v["canonical"].(string) {
				t.Fatalf("canonical bytes differ\n have %s\n want %s", canonical, v["canonical"])
			}
			if digest != v["digest"].(string) {
				t.Fatalf("%s: have %s, want %s", v["anchor"], digest, v["digest"])
			}
			ok, err := Verify(v["digest"].(string), typ, iss, v["value"])
			if err != nil || !ok {
				t.Fatalf("Verify: %v %v", ok, err)
			}
			// The printed canonical bytes parse and canonicalize to themselves.
			again, err := ParseStrict([]byte(v["canonical"].(string)))
			if err != nil {
				t.Fatal(err)
			}
			if c, _ := Canonicalize(again); string(c) != v["canonical"].(string) {
				t.Fatalf("the printed canonical bytes are not a JCS fixed point")
			}
			t.Logf("%s %s = %s", typ, v["anchor"], digest)
		})
	}
}

// TestRejections holds the parse-time refusals of Section 6.3.3.
func TestRejections(t *testing.T) {
	doc := load(t, "appendix-d-integrity-anchors.json")
	for _, raw := range doc["rejections"].([]any) {
		r := raw.(map[string]any)
		name := r["name"].(string)
		t.Run(name, func(t *testing.T) {
			_, err := ParseStrict([]byte(r["json"].(string)))
			if err == nil {
				t.Fatalf("accepted %s", r["json"])
			}
			if (name == "duplicate-member" || name == "duplicate-member-nested") && !errors.Is(err, ErrDuplicateMember) {
				t.Fatalf("want ErrDuplicateMember, have %v", err)
			}
			t.Logf("refused: %v", err)
		})
	}
	t.Run("unknown-prefix", func(t *testing.T) {
		u := doc["unknownPrefix"].(map[string]any)
		v := doc["vectors"].([]any)[0].(map[string]any)
		_, err := Verify(u["digest"].(string), v["typ"].(string), v["iss"].(string), v["value"])
		if !errors.Is(err, ErrUnknownPrefix) {
			t.Fatalf("want ErrUnknownPrefix, have %v", err)
		}
		t.Logf("refused: %v", err)
	})
	t.Run("typ-separates-domains", func(t *testing.T) {
		v := doc["vectors"].([]any)[0].(map[string]any)
		a, _, _ := Compute("mission-intent", v["iss"].(string), v["value"])
		b, _, _ := Compute("mission-authority-set", v["iss"].(string), v["value"])
		c, _, _ := Compute("mission-intent", "https://as2.example.com", v["value"])
		if a == b || a == c {
			t.Fatalf("typ or iss did not change the anchor")
		}
	})
}

// TestNumbers holds Number to ECMAScript's serialization for doubles the
// Appendix D vectors do not reach.
func TestNumbers(t *testing.T) {
	doc := load(t, "jcs-number-serialization.json")
	for _, raw := range doc["numbers"].([]any) {
		n := raw.(map[string]any)
		bits, err := strconv.ParseUint(n["ieee754"].(string), 16, 64)
		if err != nil {
			t.Fatal(err)
		}
		got, err := Number(math.Float64frombits(bits))
		if err != nil {
			t.Fatal(err)
		}
		if got != n["serialized"].(string) {
			t.Errorf("%s: have %s, want %s", n["ieee754"], got, n["serialized"])
		}
	}
}
