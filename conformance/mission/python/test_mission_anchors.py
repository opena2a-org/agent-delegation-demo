import os
import struct
import unittest

import mission_anchors as ma

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    with open(os.path.join(HERE, "..", "vectors", name), "rb") as f:
        return ma.parse_strict(f.read())


class AppendixD(unittest.TestCase):
    def test_vectors(self):
        doc = load("appendix-d-integrity-anchors.json")
        self.assertEqual(len(doc["vectors"]), 6)
        for v in doc["vectors"]:
            with self.subTest(v["name"]):
                digest, canonical = ma.compute(v["typ"], v["iss"], v["value"])
                self.assertEqual(canonical.decode("utf-8"), v["canonical"])
                self.assertEqual(digest, v["digest"])
                self.assertTrue(ma.verify(v["digest"], v["typ"], v["iss"], v["value"]))
                again = ma.parse_strict(v["canonical"])
                self.assertEqual(ma.canonicalize(again).decode("utf-8"), v["canonical"])
                print(f"{v['name']}: {v['typ']} {v['anchor']} = {digest}")


class Rejections(unittest.TestCase):
    def test_parse_time_refusals(self):
        doc = load("appendix-d-integrity-anchors.json")
        for r in doc["rejections"]:
            with self.subTest(r["name"]):
                with self.assertRaises(ValueError) as cm:
                    ma.parse_strict(r["json"])
                if r["name"].startswith("duplicate-member"):
                    self.assertIsInstance(cm.exception, ma.DuplicateMemberError)
                print(f"{r['name']}: refused: {type(cm.exception).__name__}: {cm.exception}")

    def test_unknown_prefix(self):
        doc = load("appendix-d-integrity-anchors.json")
        v = doc["vectors"][0]
        with self.assertRaises(ma.UnknownPrefixError):
            ma.verify(doc["unknownPrefix"]["digest"], v["typ"], v["iss"], v["value"])

    def test_typ_and_iss_separate(self):
        v = load("appendix-d-integrity-anchors.json")["vectors"][0]
        a = ma.compute("mission-intent", v["iss"], v["value"])[0]
        self.assertNotEqual(a, ma.compute("mission-authority-set", v["iss"], v["value"])[0])
        self.assertNotEqual(a, ma.compute("mission-intent", "https://as2.example.com", v["value"])[0])


class Numbers(unittest.TestCase):
    def test_ecmascript_serialization(self):
        for n in load("jcs-number-serialization.json")["numbers"]:
            with self.subTest(n["ieee754"]):
                f = struct.unpack(">d", bytes.fromhex(n["ieee754"]))[0]
                self.assertEqual(ma.number(f), n["serialized"])


if __name__ == "__main__":
    unittest.main()
