"""Integrity anchors of draft-mcguinness-oauth-mission-02, Section 6.3.

The envelope {"iss", "typ", "value"} is canonicalized with JCS (RFC 8785),
hashed with SHA-256 and written as "sha-256:" followed by base64url with no
padding. Python standard library and nothing else.
"""

import base64
import decimal
import hashlib
import json
import math

PREFIX = "sha-256:"


class DuplicateMemberError(ValueError):
    """An object names a member twice (Section 6.3.3: rejected at parse time)."""


class UnknownPrefixError(ValueError):
    """A digest's algorithm prefix is not sha-256: (Section 6.3.3)."""


def _pairs(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise DuplicateMemberError(f"duplicate member name {k!r}")
        out[k] = v
    return out


def _no_constant(name):
    raise ValueError(f"{name} is not JSON")


def _number(text):
    f = float(text)
    if math.isinf(f):
        raise ValueError(f"number outside the IEEE 754 double range: {text}")
    return f


def _check_strings(v):
    if isinstance(v, str):
        v.encode("utf-8")  # a lone surrogate raises UnicodeEncodeError
    elif isinstance(v, list):
        for e in v:
            _check_strings(e)
    elif isinstance(v, dict):
        for k, e in v.items():
            _check_strings(k)
            _check_strings(e)


def parse_strict(data):
    """Parse I-JSON (RFC 7493) text or bytes. Invalid UTF-8, a lone surrogate,
    a duplicate member name, a number outside the double range and NaN or
    Infinity are each an error; none is adapted."""
    text = data.decode("utf-8") if isinstance(data, (bytes, bytearray)) else data
    v = json.loads(text, object_pairs_hook=_pairs, parse_constant=_no_constant,
                   parse_float=_number, parse_int=_number)
    _check_strings(v)
    return v


def number(f):
    """A double as ECMAScript's Number serialization writes it, the form
    RFC 8785 Section 3.2.2.3 requires."""
    if isinstance(f, bool) or not isinstance(f, (int, float)):
        raise TypeError("not a number")
    f = float(f)
    if math.isnan(f) or math.isinf(f):
        raise ValueError("a number that is not finite has no JSON form")
    if f == 0:
        return "0"
    sign = "-" if f < 0 else ""
    t = decimal.Decimal(repr(abs(f))).normalize().as_tuple()
    digits = "".join(str(d) for d in t.digits)
    k, n = len(digits), len(t.digits) + t.exponent
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        out = digits[0] + ("." + digits[1:] if k > 1 else "")
        out += f"e+{n - 1}" if n - 1 >= 0 else f"e-{1 - n}"
    return sign + out


_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _quote(s):
    s.encode("utf-8")
    out = ['"']
    for ch in s:
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _write(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return number(v)
    if isinstance(v, str):
        return _quote(v)
    if isinstance(v, list):
        return "[" + ",".join(_write(e) for e in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(_quote(k) + ":" + _write(v[k]) for k in keys) + "}"
    raise TypeError(f"value of type {type(v).__name__} is not in the JSON data model")


def canonicalize(v):
    """The JCS form of v (RFC 8785), as UTF-8 bytes."""
    return _write(v).encode("utf-8")


def envelope(typ, iss, value):
    return {"typ": typ, "iss": iss, "value": value}


def compute(typ, iss, value):
    """The anchor of value under typ and iss, and the canonical bytes it hashed."""
    c = canonicalize(envelope(typ, iss, value))
    d = base64.urlsafe_b64encode(hashlib.sha256(c).digest()).decode("ascii").rstrip("=")
    return PREFIX + d, c


def verify(digest, typ, iss, value):
    """True when digest is the anchor of value. A digest with any prefix
    other than sha-256: raises, never compares."""
    if not digest.startswith(PREFIX):
        raise UnknownPrefixError("unrecognized anchor algorithm prefix")
    return compute(typ, iss, value)[0] == digest
