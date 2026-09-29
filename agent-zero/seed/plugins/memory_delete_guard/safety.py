"""Never use a vector similarity result as authority for destructive removal."""
import json
import os
from pathlib import Path
import time
import uuid


def select_ids(documents, query, *, predicate=None, confirm_ids=None):
    needle = str(query or '').strip().casefold()
    if len(needle) < 3:
        raise ValueError('Use um assunto literal com pelo menos três caracteres.')
    matched = [doc for doc in documents if needle in doc.page_content.casefold()
               and (predicate is None or predicate(doc.metadata))]
    ids = [str(doc.metadata['id']) for doc in matched]
    if confirm_ids is not None:
        if not isinstance(confirm_ids, list) or any(not isinstance(x, str) for x in confirm_ids):
            raise ValueError('confirm_ids deve ser uma lista de IDs.')
        if not set(confirm_ids).issubset(ids):
            raise ValueError('A seleção inclui um ID fora do assunto literal solicitado.')
        return list(dict.fromkeys(confirm_ids)), ids
    return (ids if len(ids) <= 1 else []), ids


def checkpoint(memory, root='/a0/usr/memory-delete-checkpoints'):
    directory = Path(root) / (str(time.time_ns()) + '-' + uuid.uuid4().hex[:8])
    directory.mkdir(parents=True, mode=0o700)
    os.chmod(directory, 0o700)
    # Complete FAISS snapshot: retains IDs, metadata AND original vectors.
    memory.db.save_local(str(directory))
    for file in directory.iterdir():
        if file.is_file(): os.chmod(file, 0o600)
    return str(directory)




async def forget_literal(tool, query='', threshold=None, filter='', confirm_ids=None, dry_run=False, **kwargs):
    from helpers.tool import Response
    from plugins._memory.helpers.memory import Memory
    memory = await Memory.get(tool.agent)
    try:
        predicate = Memory._get_comparator(filter) if filter else None
        ids, matches = select_ids(memory.db.get_all_docs().values(), query,
                                  predicate=predicate, confirm_ids=confirm_ids)
    except (ValueError, KeyError) as error:
        return Response(json.dumps({'error':str(error),'memories_deleted':0},ensure_ascii=False),False)
    if dry_run or (matches and not ids):
        return Response(json.dumps({'memories_deleted':0,'preview_ids':matches,
            'confirmation_required':len(matches)>1,
            'instruction':'Confira os IDs e a autorização do usuário; passe apenas os IDs desejados em confirm_ids. A busca é literal, não semântica.'},ensure_ascii=False),False)
    backup = checkpoint(memory) if ids else None
    removed = await memory.delete_documents_by_ids(ids, cascade=False) if ids else []
    return Response(json.dumps({'memories_deleted':len(removed),'deleted_ids':ids,
        'checkpoint':backup,'match_mode':'literal','cascade':False},ensure_ascii=False),False)


async def delete_exact(tool, ids='', **kwargs):
    from helpers.tool import Response
    from plugins._memory.helpers.memory import Memory
    if not isinstance(ids,str):
        return Response(json.dumps({'error':'ids deve ser texto com IDs separados por vírgulas.','memories_deleted':0}),False)
    ids=list(dict.fromkeys(value.strip() for value in ids.split(',') if value.strip()))
    memory=await Memory.get(tool.agent)
    backup=checkpoint(memory) if ids else None
    removed=await memory.delete_documents_by_ids(ids,cascade=False) if ids else []
    return Response(json.dumps({'memories_deleted':len(removed),'deleted_ids':[doc.metadata['id'] for doc in removed],'checkpoint':backup,'cascade':False},ensure_ascii=False),False)
