"""Собирает catalog.json из data/books_*.jsonl и data/meta.json и проверяет данные. Запуск: python3 scripts/build.py"""
import json, glob, os, sys, collections, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
OUT = os.path.join(HERE, '..', 'catalog.json')


meta = json.load(open(os.path.join(DATA, 'meta.json'), encoding='utf-8'))
books = []
for f in sorted(glob.glob(os.path.join(DATA, 'books_*.jsonl'))):
    for n, line in enumerate(open(f, encoding='utf-8'), 1):
        line = line.strip()
        if not line:
            continue
        try:
            books.append(json.loads(line))
        except Exception as e:
            print('JSON error', os.path.basename(f), n, e); sys.exit(1)

errors = []
ids = collections.Counter(b['id'] for b in books)
for i, c in ids.items():
    if c > 1: errors.append(f'duplicate id {i}')
cat_ids = {c['id'] for c in meta['cats']}
tag_ids = set(meta['tags'])
mood_ids = set(meta['moods'])
idset = set(ids)
req = ['id', 't', 'a', 'y', 'ty', 'c', 'tg', 'm', 'len', 'd']
for b in books:
    for k in req:
        if k not in b: errors.append(f'{b.get("id")} missing {k}')
    if b['ty'] not in ('f', 'n'): errors.append(f'{b["id"]} bad ty')
    if b['len'] not in (1, 2, 3): errors.append(f'{b["id"]} bad len')
    if not isinstance(b['y'], int): errors.append(f'{b["id"]} bad year')
    for c in b['c']:
        if c not in cat_ids: errors.append(f'{b["id"]} unknown cat {c}')
    for t in b['tg']:
        if t not in tag_ids: errors.append(f'{b["id"]} unknown tag {t}')
    for m in b['m']:
        if m not in mood_ids: errors.append(f'{b["id"]} unknown mood {m}')
    if '"' in b['d'] or '"' in b['t']: errors.append(f'{b["id"]} straight quote')
for col in meta['collections']:
    for i in col['ids']:
        if i not in idset: errors.append(f'collection {col["id"]} unknown {i}')
for l in meta['links']:
    for k in ('f', 'to'):
        if l[k] not in idset: errors.append(f'link unknown {l[k]}')
for c in meta['concepts']:
    for t in c.get('t', []):
        if t not in tag_ids: errors.append(f'concept {c["id"]} unknown tag {t}')
    for t in c.get('c', []):
        if t not in cat_ids: errors.append(f'concept {c["id"]} unknown cat {t}')
    for key in ('m', 'nm', 'nb'):
        for t in c.get(key, []):
            if t not in mood_ids: errors.append(f'concept {c["id"]} unknown mood {t} in {key}')
    for t in c.get('sup', []):
        if t not in {x['id'] for x in meta['concepts']}: errors.append(f'concept {c["id"]} unknown sup {t}')
    for k in c['k']:
        if 'ё' in k or k != k.lower(): errors.append(f'concept {c["id"]} key not normalized: {k}')
for t in meta['needs']:
    if t not in tag_ids: errors.append(f'need unknown tag {t}')

if errors:
    print('\n'.join(errors)); sys.exit(1)

cat_count = collections.Counter(c for b in books for c in b['c'])
mood_count = collections.Counter(m for b in books for m in b['m'])
tag_count = collections.Counter(t for b in books for t in b['tg'])
unused_tags = [t for t in tag_ids if tag_count[t] == 0]
print('books', len(books), 'fiction', sum(b['ty'] == 'f' for b in books), 'nonfiction', sum(b['ty'] == 'n' for b in books))
print('categories:', ', '.join(f'{c["id"]}={cat_count[c["id"]]}' for c in meta['cats']))
print('moods:', dict(mood_count))
print('unused tags:', unused_tags)
print('collections', len(meta['collections']), 'links', len(meta['links']), 'concepts', len(meta['concepts']))

catalog = {'v': 1, 'updated': datetime.date.today().isoformat(), **meta, 'books': books}
s = json.dumps(catalog, ensure_ascii=False, separators=(',', ':'))
open(OUT, 'w', encoding='utf-8').write(s)
print('catalog.json bytes', len(s.encode('utf-8')))
