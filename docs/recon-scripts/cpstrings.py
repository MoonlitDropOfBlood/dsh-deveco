#!/usr/bin/env python3
"""Dump the constant-pool UTF8 strings of a JVM .class file (and mark
StringBuilder-concat recipes, which contain \\u0001 placeholders).

usage: cpstrings.py <class-file> [-a] [-g regex]
  -a  also print <init>/method names & descriptors (raw pool order)
  -g  only print entries matching the regex
"""
import sys
import re

def parse(path):
    b = open(path, "rb").read()
    if b[:4] != b"\xca\xfe\xba\xbe":
        raise SystemExit("not a class file")
    p = 8
    cp_count = int.from_bytes(b[p:p + 2], "big"); p += 2
    pool = []           # index -> (tag, value)
    i = 1
    while i < cp_count:
        tag = b[p]; p += 1
        if tag == 1:                                  # Utf8
            n = int.from_bytes(b[p:p + 2], "big"); p += 2
            pool.append((tag, b[p:p + n].decode("utf-8", "replace"))); p += n
        elif tag in (7, 8, 16, 19, 20):                # Class/String/MethodType/Module/Package
            pool.append((tag, int.from_bytes(b[p:p + 2], "big"))); p += 2
        elif tag in (15,):                             # MethodHandle
            p += 3; pool.append((tag, None))
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):     # int/float/fieldref/methodref/iface/nameandtype/dynamic/invokedyn
            p += 4; pool.append((tag, None))
        elif tag in (5, 6):                            # long/double (two slots)
            p += 8; pool.append((tag, None)); pool.append((0, None)); i += 1
        else:
            raise SystemExit("unknown cp tag %d at %d" % (tag, p))
        i += 1
    return pool

def main():
    path = sys.argv[1]
    all_ = "-a" in sys.argv
    pat = None
    if "-g" in sys.argv:
        pat = re.compile(sys.argv[sys.argv.index("-g") + 1], re.I)
    for idx, (tag, val) in enumerate(parse(path)):
        if tag != 1:
            continue
        s = val
        if "\x01" in s:
            s = s.replace("\x01", "<A>")
        printable = all(ch.isprintable() or ch == "\n" for ch in s)
        if not (printable or "\x01" in val):
            continue
        if not all_ and re.fullmatch(r"[A-Za-z0-9_$./;()\[\]<>*+|-]{0,3}", s):
            continue
        if pat and not pat.search(s):
            continue
        print("#%-4d %s" % (idx, s))

main()
