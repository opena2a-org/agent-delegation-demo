// Package missionanchors computes and checks the integrity anchors of
// draft-mcguinness-oauth-mission-02, Section 6.3: the envelope
// {"iss", "typ", "value"} canonicalized with JCS (RFC 8785), hashed with
// SHA-256 and written as "sha-256:" followed by base64url with no padding.
// It uses the Go standard library and nothing else.
package missionanchors

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Prefix is the algorithm prefix of every anchor this package writes.
const Prefix = "sha-256:"

// ErrDuplicateMember is returned for an object that names a member twice
// (Section 6.3.3: rejected at parse time, before the data model exists).
var ErrDuplicateMember = errors.New("duplicate member name")

// ErrUnknownPrefix is returned for a digest whose algorithm prefix is not
// sha-256: (Section 6.3.3).
var ErrUnknownPrefix = errors.New("unrecognized anchor algorithm prefix")

// ParseStrict parses I-JSON text (RFC 7493). Invalid UTF-8, a lone
// surrogate, a duplicate member name, a number outside the IEEE 754 double
// range and trailing input are each an error; none is adapted.
func ParseStrict(text []byte) (any, error) {
	if !utf8.Valid(text) {
		return nil, errors.New("input is not valid UTF-8")
	}
	p := &parser{s: text}
	p.ws()
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.s) {
		return nil, fmt.Errorf("trailing input at offset %d", p.i)
	}
	return v, nil
}

type parser struct {
	s []byte
	i int
}

func (p *parser) ws() {
	for p.i < len(p.s) && strings.IndexByte(" \t\n\r", p.s[p.i]) >= 0 {
		p.i++
	}
}

func (p *parser) value() (any, error) {
	if p.i >= len(p.s) {
		return nil, errors.New("unexpected end of input")
	}
	c := p.s[p.i]
	switch {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.str()
	case c == 't':
		return p.literal("true", true)
	case c == 'f':
		return p.literal("false", false)
	case c == 'n':
		return p.literal("null", nil)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return nil, fmt.Errorf("unexpected character at offset %d", p.i)
}

func (p *parser) literal(word string, v any) (any, error) {
	if !strings.HasPrefix(string(p.s[p.i:]), word) {
		return nil, fmt.Errorf("unexpected literal at offset %d", p.i)
	}
	p.i += len(word)
	return v, nil
}

func (p *parser) object() (any, error) {
	p.i++ // {
	out := map[string]any{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return out, nil
	}
	for {
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return nil, fmt.Errorf("expected a member name at offset %d", p.i)
		}
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		name := k.(string)
		if _, seen := out[name]; seen {
			return nil, fmt.Errorf("%w: %q", ErrDuplicateMember, name)
		}
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return nil, fmt.Errorf("expected ':' at offset %d", p.i)
		}
		p.i++
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		out[name] = v
		p.ws()
		if p.i >= len(p.s) {
			return nil, errors.New("unexpected end of input in an object")
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == '}' {
			p.i++
			return out, nil
		}
		return nil, fmt.Errorf("expected ',' or '}' at offset %d", p.i)
	}
}

func (p *parser) array() (any, error) {
	p.i++ // [
	out := []any{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return out, nil
	}
	for {
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		out = append(out, v)
		p.ws()
		if p.i >= len(p.s) {
			return nil, errors.New("unexpected end of input in an array")
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == ']' {
			p.i++
			return out, nil
		}
		return nil, fmt.Errorf("expected ',' or ']' at offset %d", p.i)
	}
}

func (p *parser) hex4() (rune, error) {
	if p.i+4 > len(p.s) {
		return 0, errors.New("short \\u escape")
	}
	n, err := strconv.ParseUint(string(p.s[p.i:p.i+4]), 16, 32)
	if err != nil {
		return 0, fmt.Errorf("bad \\u escape at offset %d", p.i)
	}
	p.i += 4
	return rune(n), nil
}

func (p *parser) str() (any, error) {
	p.i++ // opening quote
	var b strings.Builder
	for {
		if p.i >= len(p.s) {
			return nil, errors.New("unterminated string")
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return b.String(), nil
		case c < 0x20:
			return nil, fmt.Errorf("unescaped control character at offset %d", p.i)
		case c == '\\':
			p.i++
			if p.i >= len(p.s) {
				return nil, errors.New("unterminated escape")
			}
			e := p.s[p.i]
			p.i++
			switch e {
			case '"', '\\', '/':
				b.WriteByte(e)
			case 'b':
				b.WriteByte('\b')
			case 'f':
				b.WriteByte('\f')
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case 'u':
				r, err := p.hex4()
				if err != nil {
					return nil, err
				}
				if r >= 0xDC00 && r <= 0xDFFF {
					return nil, errors.New("lone low surrogate in a string")
				}
				if r >= 0xD800 && r <= 0xDBFF {
					if p.i+6 > len(p.s) || p.s[p.i] != '\\' || p.s[p.i+1] != 'u' {
						return nil, errors.New("lone high surrogate in a string")
					}
					p.i += 2
					lo, err := p.hex4()
					if err != nil {
						return nil, err
					}
					if lo < 0xDC00 || lo > 0xDFFF {
						return nil, errors.New("lone high surrogate in a string")
					}
					r = utf16.DecodeRune(r, lo)
				}
				b.WriteRune(r)
			default:
				return nil, fmt.Errorf("bad escape at offset %d", p.i-1)
			}
		default:
			b.WriteByte(c)
			p.i++
		}
	}
}

func (p *parser) number() (any, error) {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	digits := func() int {
		n := 0
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.i < len(p.s) && p.s[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return nil, fmt.Errorf("bad number at offset %d", start)
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return nil, fmt.Errorf("bad fraction at offset %d", start)
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return nil, fmt.Errorf("bad exponent at offset %d", start)
		}
	}
	f, err := strconv.ParseFloat(string(p.s[start:p.i]), 64)
	if err != nil || math.IsInf(f, 0) {
		return nil, fmt.Errorf("number outside the IEEE 754 double range at offset %d", start)
	}
	return f, nil
}

// Canonicalize writes v in the JCS form of RFC 8785.
func Canonicalize(v any) ([]byte, error) {
	var b strings.Builder
	if err := write(&b, v); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

func write(b *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case float64:
		s, err := Number(x)
		if err != nil {
			return err
		}
		b.WriteString(s)
	case int:
		return write(b, float64(x))
	case string:
		return quote(b, x)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := write(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := quote(b, k); err != nil {
				return err
			}
			b.WriteByte(':')
			if err := write(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("value of type %T is not in the JSON data model", v)
	}
	return nil
}

// utf16Less orders member names by their UTF-16 code units (RFC 8785,
// Section 3.2.3).
func utf16Less(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

func quote(b *strings.Builder, s string) error {
	if !utf8.ValidString(s) {
		return errors.New("string is not valid UTF-8")
	}
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return nil
}

// Number writes a double as ECMAScript's Number serialization does, the form
// RFC 8785 Section 3.2.2.3 requires.
func Number(f float64) (string, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "", errors.New("a number that is not finite has no JSON form")
	}
	if f == 0 {
		return "0", nil
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	mantissa, exponent, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	e, err := strconv.Atoi(exponent)
	if err != nil {
		return "", err
	}
	k, n := len(digits), e+1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		out = digits[:1]
		if k > 1 {
			out += "." + digits[1:]
		}
		if n-1 >= 0 {
			out += "e+" + strconv.Itoa(n-1)
		} else {
			out += "e-" + strconv.Itoa(1-n)
		}
	}
	return sign + out, nil
}

// Envelope is the object Section 6.3.1 step 1 constructs.
func Envelope(typ, iss string, value any) map[string]any {
	return map[string]any{"typ": typ, "iss": iss, "value": value}
}

// Compute returns the anchor of value under typ and iss, and the canonical
// bytes it hashed.
func Compute(typ, iss string, value any) (string, []byte, error) {
	c, err := Canonicalize(Envelope(typ, iss, value))
	if err != nil {
		return "", nil, err
	}
	sum := sha256.Sum256(c)
	return Prefix + base64.RawURLEncoding.EncodeToString(sum[:]), c, nil
}

// Verify reports whether digest is the anchor of value under typ and iss. A
// digest with any prefix other than sha-256: is an error, never a mismatch.
func Verify(digest, typ, iss string, value any) (bool, error) {
	if !strings.HasPrefix(digest, Prefix) {
		return false, ErrUnknownPrefix
	}
	got, _, err := Compute(typ, iss, value)
	if err != nil {
		return false, err
	}
	return got == digest, nil
}
