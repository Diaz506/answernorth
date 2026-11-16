"""Bounded JSON decoding with duplicate-key and non-finite-value rejection."""

import json


class StrictJSONError(ValueError):
    """Content-free rejection of malformed JSON."""


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise StrictJSONError("INVALID_JSON")
        result[key] = value
    return result


def _constant(_value):
    raise StrictJSONError("INVALID_JSON")


def loads(raw, maximum_bytes):
    if not isinstance(raw, str) or type(maximum_bytes) is not int or maximum_bytes < 1 or len(raw) > maximum_bytes:
        raise StrictJSONError("INVALID_JSON")
    try:
        if len(raw.encode("utf-8")) > maximum_bytes:
            raise StrictJSONError("INVALID_JSON")
        return json.loads(raw, object_pairs_hook=_pairs, parse_constant=_constant)
    except (UnicodeEncodeError, json.JSONDecodeError, RecursionError):
        raise StrictJSONError("INVALID_JSON") from None
