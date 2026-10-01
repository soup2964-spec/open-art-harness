"""One-off: derive fixtures/seeds/model_costs.csv from research/04_model_economics.csv,
applying the corrections in research/12_verification_context.md. Rows whose model has no
capability id in shipped code are skipped (reported)."""
import csv, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else '../../../../test/openart_2026-09-29/research/04_model_economics.csv'
CAPS = set(re.findall(r'^  "([^"]+)",$', open(os.path.join(HERE, '..', 'src', 'capability-ids.ts')).read(), re.M))
OUT = os.path.join(HERE, '..', 'fixtures', 'seeds', 'model_costs.csv')

def model_map(family, model, setting):
    m = re.sub(r'\s*\(.*\)$', '', model).strip()   # drop "(default …)" labels (A/B, research/12 V4)
    video = {
        'Seedance 2.0': 'byte-plus-seedance-2', 'Seedance 2.0 Fast': 'byte-plus-seedance-2-fast',
        'Seedance 2.0 Mini': 'byte-plus-seedance-2-mini', 'Seedance 2.5': 'byte-plus-seedance-2-5',
        'Seedance 1.5 Pro': 'byte-plus-seedance-1-5', 'Veo 3.1 Standard': 'veo3-1', 'Veo 3.1 Fast': 'veo3-1',
        'Veo 3.1 Lite': 'veo3-1', 'Gemini Omni Flash': 'gemini-omni-flash', 'Gemini Omni 1.1 Flash': 'gemini-omni-1-1-flash',
        'Kling 3.0': 'kling-v3', 'Kling 3 Omni': 'kling-3-omni', 'Kling 2.6': 'kling2-6', 'Kling 2.5 Turbo': 'kling2-5',
        'Kling 2.1 Master': 'kling2-1-master', 'Kling O1': 'kling-O1', 'MiniMax H3': 'minimax-h3',
        'MiniMax H3 Max': 'fal-h3-max', 'MiniMax H3 Max Turbo': 'fal-h3-max-turbo', 'Hailuo 2.3': 'hailuo-2-3',
        'Hailuo 02': 'hailuo-02', 'Wan 3.0': 'wan3-0', 'Wan 3.0 Prime': 'wan3-0-prime', 'Wan 2.5': 'wan2-5',
        'HappyHorse 1.0': 'happyhorse', 'HappyHorse 1.1': 'happyhorse-1-1', 'Grok Imagine video': 'grok-imagine',
        'Grok Imagine 1.5': 'grok-imagine-1-5', 'LTX 2.5 Fast': 'ltx2-5', 'LTX 2.5 Pro': 'ltx2-5',
        'PixVerse V6': 'pixverseV6', 'PixVerse C1': 'pixverseC1', 'PixVerse 5': 'pixelverse5', 'FLUX 3 Video': 'flux-3-video',
    }
    image = {
        'Nano Banana': 'nano-banana', 'Nano Banana 2': 'nano-banana-2', 'Nano Banana 2 Lite': 'nano-banana-2-lite',
        'Nano Banana Pro': 'nano-banana-pro', 'GPT Image 2.5 Flare': 'gpt-image-2-5', 'GPT Image 2': 'gpt-image-2',
        'GPT Image 1.5': 'gpt-image-1-5', 'Seedream 4.5': 'byte-plus-seedream-4-5', 'Seedream 4.0': 'byte-plus-seedream-4',
        'Seedream 5.0 Lite': 'byte-plus-seedream-5-lite', 'Seedream 5.0 Pro': 'byte-plus-seedream-5-pro',
        'Seedream 5.0 Flash': 'byte-plus-seedream-5-flash', 'Flux 2 Pro': 'flux-2-pro', 'Flux 2 Max': 'flux-2-max',
        'Flux 2 Flex': 'flux-2-flex', 'Flux 2 Klein 9B': 'flux-2-klein-9b', 'FLUX.1 Kontext Pro': 'flux-kontext-pro',
        'FLUX.1 Kontext Max': 'flux-kontext-max', 'FLUX 1.1 Pro': 'flux-1-1-pro', 'Recraft V4': 'recraft-v4',
        'Recraft V4 Pro': 'recraft-v4-pro', 'Recraft V4.1': 'recraft-v4-1', 'Qwen Image 3': 'qwen-image-3',
        'Grok Imagine image': 'grok-imagine', 'Grok Imagine Image 2.0': 'grok-imagine-image-2',
        'Kling 3 Omni / O1 image': 'kling-3-omni', 'Z-Image': 'z-image', 'SDXL-class': 'openart-sdxl',
        'Midjourney V7': 'midjourney-v7', 'Reve 2.1': 'reve-2.1',
    }
    other = {  # (model id, capability id)
        'MiniMax Speech 2.8 HD': ('minimax-speech-2-8-hd', 'minimax-speech-2-8-hd:text2speech'),
        'Lyria 3 Pro': ('lyria-3-pro-preview', 'lyria-3-pro-preview:text2music'),
        'Lyria 3 Clip': ('lyria-3-clip-preview', 'lyria-3-clip-preview:text2music'),
        'Mirelo SFX': ('mirelo', 'mirelo:generate-sfx'), 'MMAudio SFX': ('mmaudio', 'mmaudio:generate-sfx'),
        'Kling AI Avatar': ('kling-avatar', 'kling-avatar:image2video'),
        'Kling LipSync': ('kling-lipsync-v1', 'kling-lipsync-v1:lipSync'),
        'DreamActor M2 motion sync': ('byte-plus-dreamactor-m2', 'byte-plus-dreamactor-m2:motion-sync'),
    }
    if model.startswith('Seedance 2.0 (via fal route)'):
        return 'byte-plus-seedance-2-fal', 'byte-plus-seedance-2-fal:text2video'
    if m == 'Wan 2.6 / 2.7':
        mid = 'wan2-7' if setting.startswith('720p') else 'wan2-6'
        return mid, f'{mid}:text2video'
    if m == 'Kling 3 Omni / O1 image': return 'kling-3-omni', 'kling-3-omni:text2image'
    if m == 'GPT Image 2.5 Flare': return 'gpt-image-2-5', 'gpt-image-2-5-flare:text2image'
    if family == 'video' and m in video: return video[m], f'{video[m]}:text2video'
    if family == 'image' and m in image: return image[m], f'{image[m]}:text2image'
    if m in other: return other[m]
    return None, None

# research/12 correction 3: GPT Image 2.5 cost from OpenAI's own calculator (196/439/1,756 tokens x $30/M).
GPT25 = {'1024x1024 low': 0.00588, '1024x1024 medium': 0.01317, '1024x1024 high': 0.05268}

rows, skipped = [], []
for r in csv.DictReader(open(SRC)):
    mid, bt = model_map(r['family'], r['model'], r['setting'])
    if not mid or bt not in CAPS:
        skipped.append(f"{r['model']} | {r['setting']}"); continue
    setting = r['setting']
    if r['model'].startswith('Veo 3.1'):
        mode = re.match(r'Veo 3\.1 (\w+)', r['model']).group(1).lower()
        setting = f'{mode} {setting}'
    credits = int(r['credits'])
    notes = []
    status = '[bt:observed]' if bt == 'openart-sdxl:text2image' else '[bt:code]'
    notes.append(status)
    cost = r['api_cost_list'].strip()
    src = r['sources'].split('api:')[-1].strip() if 'api:' in r['sources'] else ''
    if mid == 'gpt-image-2-5':
        cost = f"{GPT25[r['setting']]:.5f}"
        src = 'https://developers.openai.com/'
        notes.append("cost = OpenAI official image-token calculator at $30/M output tokens (research/12 V3, correction 3; saved research/12_evidence/vendors/openai_GptImageTokenCalculator.js); 04 cited fal")
    if mid == 'z-image':
        notes.append('04 listed 5 credits; logged-in UI shows 8 at the 1:1 1MP default (research/09 MISMATCH); UI value used')
        credits = 8
    if '(default create' in r['model'] or '(default image' in r['model']:
        notes.append('04 called this a default model; defaults are A/B-assigned per visitor (research/12 V4), label dropped')
    if r['model'].startswith('Nano Banana Pro'):
        notes.append('Gemini Batch/Flex tiers are 50% lower (research/12 correction 4)')
    if r['api_cost_flag'] == 'E':
        notes.append('ESTIMATE, not a published list price (04 flag E)')
    promo = re.search(r'\(promo to ([0-9-]+)\)', r['model'])
    if promo:
        setting = f"{setting} promo-to-{promo.group(1)}"
        notes.append('promotional credit rate (campaign code, time-limited)')
    if r['note']:
        notes.append(r['note'].strip())
    if r['api_price_basis']:
        notes.append(f"basis: {r['api_price_basis'].strip()}")
    cpc = ''
    if cost:
        cpc = f"{float(cost) / credits:.7f}".rstrip('0').rstrip('.')
    rows.append([mid, bt, setting, str(credits), cost, cpc, src, '; '.join(notes)])

with open(OUT, 'w', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['model_id','business_type','setting','credits','list_cost_usd','cost_per_credit_usd','source_url','notes'])
    w.writerows(rows)
print(len(rows), 'rows written; skipped', len(skipped))
for s in skipped: print('  skipped:', s)
