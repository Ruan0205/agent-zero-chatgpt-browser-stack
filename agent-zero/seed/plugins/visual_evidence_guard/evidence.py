"""Pure evidence validation; never select a file from global uploads by recency."""
import hashlib
import re
from pathlib import Path

from PIL import Image, ImageStat

IMAGE_PATH = re.compile(r"/(?:a0|workspace|tmp)/[^\s`\"'<>]+?\.(?:png|jpe?g|webp)(?=[\s`\"'<>]|$)", re.I)
VISUAL_REVIEW = re.compile(r"cr[ií]tic[oa].{0,25}visual|visual.{0,25}(?:critic|review|evaluat)|(?:nota|score).{0,80}(?:refer[eê]ncia|modelo|imagem|image)|(?:compare|comparar).{0,60}(?:render|modelo|screenshot)", re.I | re.S)


def inspect_image(path):
    p = Path(path).resolve(strict=True)
    # Do not reject merely small/dark images. Require near-zero spatial variation.
    with Image.open(p) as image:
        image.load()
        rgb = image.convert('RGB')
        sample = rgb.copy()
        sample.thumbnail((256, 256))
        variation = max(ImageStat.Stat(sample).stddev)
        report = {'path': str(p), 'width': rgb.width, 'height': rgb.height,
                  'stddev': round(variation, 4), 'uniform': variation < 0.25}
    report['sha256'] = hashlib.sha256(p.read_bytes()).hexdigest()
    return report


def is_visual_review(message):
    return bool(VISUAL_REVIEW.search(str(message)))


def evidence_paths(message, attachments=(), last_capture=None):
    paths = [str(p) for p in attachments or ()]
    paths.extend(IMAGE_PATH.findall(str(message)))
    # Only use the last capture actually returned to THIS parent, never uploads.
    if not paths and last_capture and last_capture.get('valid'):
        paths.append(last_capture['path'])
    return list(dict.fromkeys(paths))


def prepare_review(message, attachments=(), last_capture=None):
    paths = evidence_paths(message, attachments, last_capture)
    if not paths:
        raise ValueError('VISUAL_EVIDENCE_MISSING: forneça paths/attachments exatos da referência e do render. Não procure o upload mais recente.')
    reports = [inspect_image(p) for p in paths]
    invalid = [r for r in reports if r['uniform']]
    if invalid:
        raise ValueError('VISUAL_EVIDENCE_INVALID: captura uniforme/vazia; não delegue nem dê nota. Corrija a renderização e capture novamente: ' + ', '.join(r['path'] for r in invalid))
    manifest = '\n'.join(f"- {r['path']} | sha256={r['sha256']} | {r['width']}x{r['height']}" for r in reports)
    base = str(message).split('\n\nEVIDÊNCIAS EXATAS DESTA AVALIAÇÃO:')[0]
    assignment = base + '\n\nEVIDÊNCIAS EXATAS DESTA AVALIAÇÃO:\n' + manifest + (
        '\nCarregue todos esses arquivos com vision_load antes de avaliar. Não substitua por uploads recentes. '
        'Identifique explicitamente a referência e o render REAL; se faltar um deles, não atribua nota. '
        'Prefira uma prancha única com referência e render lado a lado. Se carregar vistas adicionais, '
        'carregue a prancha de comparação por último antes da avaliação. Descreva separadamente '
        'o que vê na referência e o que vê no render; não transfira defeitos do render para a referência. '
        'Não deduza elmo, armadura, ferramentas ou outros detalhes a partir de palavras como cavaleiro: '
        'só cite elementos que os pixels realmente mostram. '
        'Descrição do pai, código-fonte e notas anteriores não são evidência visual. '
        'Se a imagem estiver vazia, errada ou sem o objeto solicitado, responda não avaliável e relate o bloqueio.')
    return assignment, [r['path'] for r in reports]


def normalize_browser_args(args):
    calls = args.get('calls') if args.get('action') == 'batch' else None
    for call in calls or [args]:
        if call.get('action') == 'evaluate':
            if not call.get('script') and call.get('expression'):
                call['script'] = call['expression']
            if not str(call.get('script') or '').strip():
                raise ValueError('browser.evaluate requer script (expression também é aceito). Código vazio não será executado como undefined.')
