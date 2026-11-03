#!/usr/bin/env python3
"""jar-cpstrings.py <jar> [regex] [--recipes-only]

Extract constant-pool UTF8 entries from every .class in a jar (no unzip needed on
disk: uses zipfile), so StringBuilder-concat recipes (containing \\u0001, printed
as <A>) and plain constants are visible.

Prints:  <entry-in-jar> :: <string>
"""
import re
import sys
import zipfile

TAG_LEN = {7: 2, 8: 2, 16: 2, 19: 2, 20: 2, 15: 3, 3: 4, 4: 4, 9: 4, 10: 4,
           11: 4, 12: 4, 17: 4, 18: 4, 5: 8, 6: 8}


def pool_strings(b):
    if b[:4] != b"\xca\xfe\xba\xbe":
        return []
    p = 8
    n = int.from_bytes(b[p:p + 2], "big")
    p += 2
    out = []
    i = 1
    while i < n:
        tag = b[p]
        p += 1
        if tag == 1:
            ln = int.from_bytes(b[p:p + 2], "big")
            p += 2
            out.append(b[p:p + ln].decode("utf-8", "replace"))
            p += ln
        else:
            ln = TAG_LEN.get(tag)
            if ln is None:
                return out
            p += ln
            if tag in (5, 6):
                i += 1
        i += 1
    return out


def main():
    jar = sys.argv[1]
    pat = re.compile(sys.argv[2], re.I) if len(sys.argv) > 2 else None
    z = zipfile.ZipFile(jar)
    seen = set()
    for name in z.namelist():
        if not name.endswith(".class"):
            continue
        for s in pool_strings(z.read(name)):
            disp = s.replace("\x01", "<A>")
            if not disp or not all(c.isprintable() for c in disp):
                continue
            if pat and not pat.search(disp):
                continue
            if (name, disp) in seen:
                continue
            seen.add((name, disp))
            print("%-70s :: %s" % (name, disp))


main()
