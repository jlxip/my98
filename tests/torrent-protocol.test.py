import json
from pathlib import Path
import sys
import unittest
import tempfile
ROOT=Path(__file__).resolve().parent.parent
sys.path[:0]=[str(ROOT/"src/torrent"),str(ROOT/"scripts")]
from identity import derive_seed
from my98_torrent.protocol import (Record, PublicationError, Conflict, compare,
    descriptor_bytes, parse_descriptor, next_sequence, MAX_SEQUENCE, signing_payload)
from nacl.signing import SigningKey
from my98_torrent.store import Store

class ProtocolTest(unittest.TestCase):
    seed=bytes(range(32))
    info_hash="12"*20

    def test_frozen_rust_identity_vector(self):
        seed=derive_seed("cafe\u0301","public compatibility test password ","main")
        self.assertEqual(bytes(SigningKey(seed).verify_key).hex(),"07d2860c1066244fa0d7973545b4dd822466d8b2c9fd83fb84331716949b3a54")
        self.assertEqual(seed,derive_seed("café","public compatibility test password ","main"))
        self.assertEqual(Record.sign(seed,123,"12"*20).signature.hex(),"512b1784e462afb245621af1ea416b1bbf35556f15d1f31372fa6a23c787f489b980fbb56f60dc0ca133904e41bac76796ee3a9c698ef09e251f2c8e6076f50b")
        self.assertEqual(Record.sign(seed,MAX_SEQUENCE,"34"*20).signature.hex(),"d69cbee3bba77d17a2023e2ad59a2cffd313df77e4273f22bc17d713970e726a05f8067004df1ca1b8172c143849d4456a77e0cc82c86192c914d00d0d808504")
        self.assertNotEqual(seed,derive_seed("café","public compatibility test password","main"))

    def test_exact_signed_wire_value_and_reannouncement_without_seed(self):
        value=bytes.fromhex(self.info_hash)
        expected=b"4:salt19:my98/publication/v13:seqi123e1:vd2:ih20:"+value+b"e"
        self.assertEqual(signing_payload(123,value),expected)
        record=Record.sign(self.seed,123,value)
        public_copy=Record.from_json(json.loads(json.dumps(record.as_json())),record.public_key)
        self.assertEqual(public_copy,record)
        self.assertEqual(set(vars(public_copy)),{"public_key","sequence","info_hash","signature"})
        public_copy.verify()

    def test_corruption_identity_target_and_salt(self):
        record=Record.sign(self.seed,1,self.info_hash)
        for key,replacement in [("infoHash","34"*20),("sequence",2),("salt","00"),("signature","00"*64),("publicKey","00"*32)]:
            with self.subTest(key=key),self.assertRaises(PublicationError):
                Record.from_json({**record.as_json(),key:replacement})
        with self.assertRaises(PublicationError):Record.from_json(record.as_json(),bytes(32))

    def test_safe_integer_sequence_generation(self):
        self.assertEqual(next_sequence(90,100),100)
        self.assertEqual(next_sequence(100,90),101)
        for bad in [True,1.5,0,-1,2**53,2**63]:
            with self.subTest(value=bad),self.assertRaises(PublicationError):Record.sign(self.seed,bad,self.info_hash)
        with self.assertRaises(PublicationError):next_sequence(MAX_SEQUENCE,100)

    def test_same_sequence_conflict_and_monotonicity(self):
        first=Record.sign(self.seed,100,self.info_hash)
        self.assertTrue(compare(None,first))
        self.assertFalse(compare(first,first))
        self.assertTrue(compare(first,Record.sign(self.seed,101,"34"*20)))
        for other in [Record.sign(self.seed,100,"34"*20),Record.sign(self.seed,99,self.info_hash)]:
            with self.assertRaises(Conflict):compare(first,other)

    def test_independent_components_and_descriptor_validation(self):
        original={"version":1,"disk":self.info_hash,"state":None,"profile":None}
        updated={**original,"state":"34"*20}
        profiled={**updated,"profile":"56"*20}
        for value in [original,updated,profiled]:
            self.assertEqual(parse_descriptor(descriptor_bytes(value)),value)
            self.assertEqual(value["disk"],self.info_hash)
        self.assertEqual(profiled["state"],updated["state"])
        for value in [{**original,"version":True},{**original,"disk":"BAD"},{**original,"unknown":1}]:
            with self.assertRaises(PublicationError):descriptor_bytes(value)
        with self.assertRaises(PublicationError):parse_descriptor(b'{"version":1,"version":1}')
        with self.assertRaises(PublicationError):parse_descriptor(b" "*4097)

class StoreTest(unittest.TestCase):
    def test_prepare_reannounce_restart_and_public_adoption(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory);key=Record.sign(bytes(range(32)),100,"12"*20).public_key
            first=Record.sign(bytes(range(32)),100,"12"*20)
            candidate=Record.sign(bytes(range(32)),102,"34"*20)
            with self.assertRaises(PublicationError):store.accept_candidate(candidate,b"metadata")
            store.follow(key);store.set_public(first)
            self.assertTrue(store.accept_candidate(candidate,b"metadata"))
            self.assertFalse(store.accept_candidate(candidate,b"metadata"))
            recovered=Store(directory)
            self.assertEqual(recovered.public(key),first)
            self.assertEqual(recovered.highest(key),first)
            self.assertEqual(recovered.candidates(),[(candidate,b"metadata")])
            for record in recovered.public_records():record.verify()
            # A signed pending candidate is not yet a public name. A concurrent
            # intermediate public commit must remain observable and conflict later.
            intermediate=Record.sign(bytes(range(32)),101,"56"*20)
            recovered.set_public(intermediate)
            self.assertEqual(recovered.public(key),intermediate)
            with self.assertRaises(Conflict):recovered.set_public(first)
            recovered.set_public(candidate)
            self.assertEqual(Store(directory).highest(key),candidate)

    def test_bad_signatures_do_not_poison_maximum(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(directory)
            good=Record.sign(bytes(range(32)),1,"12"*20);store.set_public(good)
            bad=Record(good.public_key,MAX_SEQUENCE,good.info_hash,bytes(64))
            with self.assertRaises(PublicationError):store.observe(bad)
            self.assertEqual(store.highest(good.public_key),good)

if __name__=="__main__":unittest.main()
