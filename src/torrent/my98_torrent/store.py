"""Persistent signed records. Pending candidates never change the public name."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
from .protocol import Record, PublicationError, compare, descriptor

class Store:
    def __init__(self, directory):
        self.directory=Path(directory)
        self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.database=self.directory/"publications.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS observed (key BLOB PRIMARY KEY, record TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS public_names (key BLOB PRIMARY KEY, record TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS adopted (key BLOB PRIMARY KEY, record TEXT NOT NULL, descriptor TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS candidates (key BLOB NOT NULL, sequence INTEGER NOT NULL, record TEXT NOT NULL, metadata BLOB NOT NULL, PRIMARY KEY(key,sequence));
                CREATE TABLE IF NOT EXISTS followed (key BLOB PRIMARY KEY);
            """)
        self.database.chmod(0o600)

    @contextmanager
    def connect(self):
        connection=sqlite3.connect(self.database,timeout=30)
        try:
            with connection:yield connection
        finally:connection.close()

    @staticmethod
    def _record(row):
        return None if row is None else Record.from_json(json.loads(row[0]))

    @staticmethod
    def _observe(db, record):
        previous=Store._record(db.execute("SELECT record FROM observed WHERE key=?",(record.public_key,)).fetchone())
        if compare(previous,record):
            db.execute("INSERT OR REPLACE INTO observed VALUES (?,?)",(record.public_key,json.dumps(record.as_json(),sort_keys=True)))
            return True
        return False

    def highest(self, key):
        with self.connect() as db:
            return self._record(db.execute("SELECT record FROM observed WHERE key=?",(key,)).fetchone())

    def public(self, key):
        with self.connect() as db:
            return self._record(db.execute("SELECT record FROM public_names WHERE key=?",(key,)).fetchone())

    def observe(self, record):
        record.verify()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return self._observe(db,record)

    def accept_candidate(self, record, metadata):
        record.verify()
        if type(metadata) is not bytes or not 1 <= len(metadata) <= 16384:
            raise PublicationError("Invalid descriptor torrent metadata size")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM followed WHERE key=?",(record.public_key,)).fetchone():
                raise PublicationError("Publication identity is not followed")
            public=self._record(db.execute("SELECT record FROM observed WHERE key=?",(record.public_key,)).fetchone())
            pending=self._record(db.execute("SELECT record FROM candidates WHERE key=? ORDER BY sequence DESC LIMIT 1",(record.public_key,)).fetchone())
            highest=max([r for r in [public,pending] if r is not None],key=lambda r:r.sequence,default=None)
            changed=compare(highest,record)
            adopted=self._record(db.execute("SELECT record FROM adopted WHERE key=?",(record.public_key,)).fetchone())
            if adopted==record:return False
            previous=db.execute("SELECT metadata FROM candidates WHERE key=? AND sequence=?",(record.public_key,record.sequence)).fetchone()
            if previous and previous[0] != metadata:
                # Same infohash can have different trackers/webseed hints; retain
                # the original, already validated metadata instead of duplicating work.
                return False
            db.execute("INSERT OR IGNORE INTO candidates VALUES (?,?,?,?)",(record.public_key,record.sequence,json.dumps(record.as_json(),sort_keys=True),metadata))
            return changed

    def set_public(self, record):
        record.verify()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous=self._record(db.execute("SELECT record FROM public_names WHERE key=?",(record.public_key,)).fetchone())
            compare(previous,record)
            self._observe(db,record)
            db.execute("INSERT OR REPLACE INTO public_names VALUES (?,?)",(record.public_key,json.dumps(record.as_json(),sort_keys=True)))

    def candidates(self):
        with self.connect() as db:
            rows=db.execute("SELECT record,metadata FROM candidates ORDER BY sequence").fetchall()
        return [(Record.from_json(json.loads(record)),bytes(metadata)) for record,metadata in rows]

    def public_records(self):
        with self.connect() as db:rows=db.execute("SELECT record FROM public_names").fetchall()
        return [self._record(row) for row in rows]

    def follow(self, key):
        if type(key) is not bytes or len(key)!=32:raise PublicationError("Invalid public key")
        with self.connect() as db:db.execute("INSERT OR IGNORE INTO followed VALUES (?)",(key,))

    def followed(self):
        with self.connect() as db:return [bytes(row[0]) for row in db.execute("SELECT key FROM followed ORDER BY key")]

    def adopted(self,key):
        with self.connect() as db:row=db.execute("SELECT record,descriptor FROM adopted WHERE key=?",(key,)).fetchone()
        return None if row is None else (Record.from_json(json.loads(row[0])),descriptor(json.loads(row[1])))

    def adopt(self,record,value):
        record.verify();value=descriptor(value)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            public=self._record(db.execute("SELECT record FROM public_names WHERE key=?",(record.public_key,)).fetchone())
            if public!=record:raise PublicationError("Cannot adopt a candidate before its public name is observed")
            previous=self._record(db.execute("SELECT record FROM adopted WHERE key=?",(record.public_key,)).fetchone())
            compare(previous,record)
            db.execute("INSERT OR REPLACE INTO adopted VALUES (?,?,?)",(record.public_key,json.dumps(record.as_json(),sort_keys=True),json.dumps(value,sort_keys=True)))
            db.execute("DELETE FROM candidates WHERE key=? AND sequence<=?",(record.public_key,record.sequence))

    def adopted_records(self):
        with self.connect() as db:rows=db.execute("SELECT record,descriptor FROM adopted").fetchall()
        return [(Record.from_json(json.loads(record)),descriptor(json.loads(value))) for record,value in rows]

    def candidate(self,key,seq):
        with self.connect() as db:row=db.execute("SELECT record,metadata FROM candidates WHERE key=? AND sequence=?",(key,seq)).fetchone()
        return None if row is None else (Record.from_json(json.loads(row[0])),bytes(row[1]))

    def maximum(self,key):
        values=[r.sequence for r in [self.highest(key)] if r is not None]
        with self.connect() as db:row=db.execute("SELECT MAX(sequence) FROM candidates WHERE key=?",(key,)).fetchone()
        return max(values+[row[0] or 0])
