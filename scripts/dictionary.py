"""Build the offline English–Russian dictionary from a pinned, licensed source.

Usage: python3 scripts/dictionary.py [--archive /path/to/source.tar.xz]
The generated TSV is an adaptation under CC BY-SA 3.0, independent of app code.
"""
import argparse
import hashlib
import html
import io
import json
from pathlib import Path
import re
import tarfile
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET

SOURCE = 'https://download.freedict.org/dictionaries/eng-rus/2025.11.23/freedict-eng-rus-2025.11.23.src.tar.xz'
CHECKSUM = 'fdee5ebdbe59c2a4293b875def3befdfddd990f95ecd10eb289eff22d815ed6d31267ca4695af66811ef368dd72b16342210475e044c995831e7931ce0e4bcfe'
NS = {'t': 'http://www.tei-c.org/ns/1.0'}


def normalized(text):
    return re.sub(r'\s+', ' ', text).strip()


def clean_translation(text):
    text = html.unescape(text)
    text = re.sub(r'\[\[([^\]|]+\|)?([^\]]+)\]\]', lambda m: m[2], text)
    text = re.sub(r'\{\{(?:l|m|t|t\+)\|ru\|([^|}]+)(?:\|[^}]*)?\}\}', lambda m: m[1], text)
    text = re.sub(r'<[^>]*>', '', text).replace("'''", '').replace("''", '')
    text = unicodedata.normalize('NFC', text.replace('\u0301', ''))
    return '' if '{{' in text or '[[' in text else normalized(text)


def build(archive):
    if hashlib.sha512(archive).hexdigest() != CHECKSUM:
        raise ValueError('Dictionary source checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(archive)) as package:
        xml = package.extractfile('eng-rus/eng-rus.tei').read()
        license_text = package.extractfile('eng-rus/COPYING').read()
    root = ET.fromstring(xml)
    words = {}
    for entry in root.findall('.//t:entry', NS):
        # Prefix/suffix entries such as -ed are not translations of standalone ed.
        positions = {p.text for p in entry.findall('t:gramGrp/t:pos', NS)}
        if positions and positions <= {'suffix', 'prefix', 'infix', 'circumfix'}:
            continue
        terms = [normalized(''.join(o.itertext())).lower() for o in entry.findall('t:form/t:orth', NS)]
        translations = []
        for citation in entry.findall('.//t:cit[@type="trans"]', NS):
            if citation.get('{http://www.w3.org/XML/1998/namespace}lang') != 'ru':
                continue
            for quote in citation.findall('t:quote', NS):
                text = clean_translation(''.join(quote.itertext()))
                if text and re.search('[А-Яа-яЁё]', text) and text not in translations:
                    translations.append(text)
        for term in terms:
            if not term or len(term) > 180 or not re.search('[a-z]', term):
                continue
            values = words.setdefault(term, [])
            for value in translations:
                if value not in values:
                    values.append(value)
    words = {k: '; '.join(v) for k, v in sorted(words.items()) if v}
    if len(words) < 50000 or 'concept' not in words:
        raise ValueError('Dictionary unexpectedly incomplete')
    target = Path('vendor/dictionary')
    target.mkdir(parents=True, exist_ok=True)
    tsv = '# WikDict / FreeDict 2025.11.23. CC BY-SA 3.0. See ATTRIBUTION.txt.\n'
    tsv += ''.join(f'{term}\t{translation}\n' for term, translation in words.items())
    (target / 'eng-rus.tsv').write_text(tsv, encoding='utf8')
    (target / 'COPYING').write_bytes(license_text)
    metadata = {
        'name': 'WikDict / FreeDict English–Russian', 'edition': '2025.11.23',
        'source': SOURCE, 'source_sha512': CHECKSUM, 'entries': len(words),
        'license': 'CC BY-SA 3.0', 'license_url': 'https://creativecommons.org/licenses/by-sa/3.0/',
        'modifications': 'TEI Russian translations flattened to lowercase TSV; stress marks removed; affixes excluded; duplicate meanings merged.'
    }
    (target / 'source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    (target / 'ATTRIBUTION.txt').write_text(
        'English–Russian dictionary: WikDict / FreeDict, edition 2025.11.23.\n'
        'Maintainer: Karl Bartel. Original data: Wiktionary contributors via DBnary.\n'
        'https://www.wikdict.com/\nhttps://www.wiktionary.org/\nhttps://freedict.org/\n'
        'License: Creative Commons Attribution-ShareAlike 3.0 Unported.\n'
        'https://creativecommons.org/licenses/by-sa/3.0/\n'
        'The accompanying COPYING preserves the source license.\n'
        'Source archive: ' + SOURCE + '\n'
        'Changes: English keys lowercased, Russian stress marks removed, affix entries excluded,\n'
        'translations flattened to TSV and duplicate meanings merged. The adapted TSV is\n'
        'distributed under the same CC BY-SA 3.0 license. Rebuild: python3 scripts/dictionary.py\n', encoding='utf8')
    print(f'Built {len(words)} offline headwords, {len(tsv.encode())} bytes. concept: {words["concept"]}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    data = args.archive.read_bytes() if args.archive else urllib.request.urlopen(SOURCE, timeout=90).read()
    build(data)
