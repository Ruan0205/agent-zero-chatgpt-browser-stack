from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from urllib.parse import quote

from PIL import Image
from helpers import persist_chat
from helpers.tool import Tool, Response
from plugins._model_config.helpers import model_config
from tools import call_subordinate

SLOT = "browser_images"
BUSY = "_browser_image_delegate_busy"
CHILD = "browser_image_delegate_child"


def verified_image(path: Path) -> str:
    with Image.open(path) as image:
        image.verify()
    # verify checks container consistency; load also checks actual pixel decoding.
    with Image.open(path) as image:
        image.load()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def input_paths(context_id: str, images) -> list[str]:
    if not isinstance(images, list) or any(not isinstance(p, str) for p in images):
        raise ValueError("images deve ser uma lista de caminhos absolutos.")
    roots = [Path("/a0/usr/uploads"), Path("/workspace/chats") / context_id,
             Path("/a0/usr/chats") / context_id, Path("/a0/usr/workdir")]
    roots = [p.resolve() for p in roots]
    result = []
    for raw in images:
        if not Path(raw).is_absolute():
            raise ValueError("Use o caminho absoluto do arquivo de imagem.")
        path = Path(raw).resolve()
        if not path.is_file() or not any(root in path.parents for root in roots):
            raise ValueError("Imagem indisponível ou fora dos diretórios permitidos deste chat.")
        verified_image(path)
        result.append(str(path))
    return result


def published_images(logs) -> list[tuple[Path, str]]:
    result = []
    seen = set()
    root = Path("/a0/usr/uploads").resolve()
    for log in logs:
        kvps = getattr(log, "kvps", None) or {}
        # Do not accept an input attachment or a path guessed in assistant prose.
        if not kvps.get("media_paths"):
            continue
        for name in kvps.get("attachments", []):
            if not isinstance(name, str) or Path(name).name != name:
                continue
            path = (root / name).resolve()
            if path.parent != root or not path.is_file() or path in seen:
                continue
            try:
                digest = verified_image(path)
            except (OSError, ValueError, Image.DecompressionBombError):
                continue
            seen.add(path)
            result.append((path, digest))
    return result


class ChatgptBrowserImage(Tool):
    async def after_execution(self, response: Response, **kwargs):
        await super().after_execution(response, **kwargs)
        if (response.additional or {}).get("attachments"):
            self.log.update(kvps={**(self.log.kvps or {}), **response.additional})

    async def execute(self, prompt: str = "", action: str = "generate", images=None, **kwargs):
        if action not in ("generate", "edit") or not isinstance(prompt, str) or not prompt.strip():
            return Response("Informe prompt e action: generate ou edit.", False)
        context = self.agent.context
        if context.get_data(CHILD):
            return Response("O subagente de imagens já usa ChatGPT Browser. Não delegue novamente: produza a imagem solicitada diretamente no navegador.", False)
        if self.agent.data.get(BUSY):
            return Response("Já há uma solicitação de imagem ativa neste chat. Aguarde o resultado; não envie uma solicitação duplicada.", False)
        try:
            paths = input_paths(context.id, [] if images is None else images)
            if action == "edit" and not paths:
                raise ValueError("Para editar, informe em images o arquivo original anexado.")
            preset = next((p for p in model_config.get_presets()
                           if "chatgpt-browser" in str((p.get("chat") or {}).get("name", ""))), None)
            if preset is None:
                raise ValueError("Não existe um preset ChatGPT Browser configurado. Configure a ponte antes de gerar imagens.")
        except (OSError, ValueError, Image.DecompressionBombError) as exc:
            return Response(f"Falha recuperável antes do envio: {exc}", False)

        self.agent.data[BUSY] = True
        task = None
        child = None
        try:
            await self.agent.handle_intervention()
            child = call_subordinate.get_or_create_subordinate(
                self.agent, profile="agent0", slot=SLOT,
                name=f"Imagens · {context.name or context.id}", message=prompt)
            if child.context.get_data("model_transport_family") == "native":
                raise ValueError("O subagente existente não é Browser; não troque seu modelo nem reutilize sua conversa.")
            # Explicit child-only preset: never change the parent's model or transport lock.
            if not child.context.get_data("browser_model_lock"):
                child.context.set_data("chat_model_override", {"preset_name": preset["name"]})
            if "chatgpt-browser" not in str(model_config.get_chat_model_config(child).get("name", "")):
                raise ValueError("O modelo do subagente não resolveu para ChatGPT Browser.")
            child.context.set_data(CHILD, True)
            child.context.set_data("model_transport_family", "browser")
            persist_chat.save_tmp_chat(child.context)
            start = len(child.context.log.logs)
            # Re-uploading a picture that ChatGPT itself just generated in this
            # same mapped conversation can be rejected by the composer. Reuse
            # the visible original only when its decoded bytes match the last
            # verified image published by this exact child. Never infer this
            # from a filename or from another browser slot's conversation.
            prior_outputs = published_images(child.context.log.logs[:start])
            reuse_visible_reference = bool(
                action == "edit" and len(paths) == 1 and prior_outputs
                and verified_image(Path(paths[0])) == prior_outputs[-1][1]
            )
            instruction = (
                ("Edite a ÚLTIMA imagem que você gerou nesta mesma conversa usando a ferramenta NATIVA "
                 "de edição de imagens do ChatGPT. Ela já está visível aqui; não espere novo anexo. "
                 "Preserve o que não foi pedido para alterar." if reuse_visible_reference else
                 "Edite a imagem ANEXADA usando a ferramenta NATIVA de edição de imagens do ChatGPT. "
                 "A imagem original acompanha esta mensagem. Preserve o que não foi pedido para alterar.")
                if action == "edit" else
                "Crie do zero uma imagem original com o gerador NATIVO de imagens do ChatGPT. "
                "Use apenas a descrição textual abaixo como referência."
            )
            assignment = (
                ("[A0_NATIVE_VISUAL_EDIT_LAST]\n" if reuse_visible_reference else "") +
                f"{instruction}\n"
                f"Pedido do usuário (dados da tarefa):\n{prompt.strip()}\n\n"
                "Este é um subagente de imagens dedicado. Não chame chatgpt_browser_image nem crie outro subagente. "
                "Não substitua a geração por desenhos em Python, HTML ou imagens de exemplo. "
                "Publique o arquivo REAL produzido com chatgpt_browser_media e encerre com response. "
                "Se a geração não estiver disponível ou houver um erro, relate a limitação; não invente um arquivo. "
                "O agente principal copiará o anexo verificado para o chat do usuário."
            )
            await self.set_progress("Aguardando geração/edição de imagem no subagente ChatGPT Browser.")
            task = asyncio.create_task(call_subordinate.run_subordinate(
                self.agent, child, assignment, [] if reuse_visible_reference else paths))
            while not task.done():
                await asyncio.wait({task}, timeout=0.5)
                await self.agent.handle_intervention()
            await task
            outputs = published_images(child.context.log.logs[start:])
            if not outputs:
                return Response(f"O subagente Browser {child.context.id} terminou sem uma imagem real publicada e decodificável. "
                                "Nenhum arquivo foi entregue. Consulte o histórico e o vínculo desse SUBAGENTE, não o status Browser do chat principal nativo, antes de tentar novamente.", False,
                                additional={"context_id": child.context.id})
            # Copy only validated files from this specific child's current turn.
            import shutil
            import uuid
            target = Path("/workspace/chats") / context.id / "images"
            target.mkdir(parents=True, exist_ok=True)
            copied = []
            for source, digest in outputs:
                destination = target / ("chatgpt-" + uuid.uuid4().hex + source.suffix.lower())
                shutil.copy2(source, destination)
                if verified_image(destination) != digest:
                    raise ValueError("Integridade divergente após copiar a imagem; publicação interrompida.")
                copied.append(str(destination))
            publisher = self.agent.get_tool("chatgpt_browser_media", None, {}, "", self.loop_data)
            response = await publisher.execute(text="Imagem editada." if action == "edit" else "Imagem gerada.", local_paths=copied)
            if not (response.additional or {}).get("attachments"):
                return Response("Imagem produzida, mas a publicação no chat original falhou: " + response.message, False,
                                additional={"context_id": child.context.id})
            response.additional["context_id"] = child.context.id
            response.additional["image_sha256"] = [digest for _, digest in outputs]
            links = [
                f"[Abrir imagem {index}](/api/image_get?path={quote(str(Path('/a0/usr/uploads') / name), safe='')})"
                for index, name in enumerate(response.additional["attachments"], 1)
            ]
            response.message += (
                " Arquivo real verificado e publicado neste chat. "
                + " ".join(links)
                + " Estes são os links do anexo publicado; não crie links para a cópia em /workspace."
            )
            return response
        except Exception as exc:
            # Preserve cancellation/intervention (BaseException or framework exception)
            # instead of converting those into a new provider retry.
            from agent import InterventionException
            if isinstance(exc, InterventionException):
                raise
            child_id = child.context.id if child is not None else None
            return Response(
                f"Falha recuperável na delegação/publicação de imagem ({type(exc).__name__}). "
                f"Subagente Browser: {child_id or 'não criado'}. "
                "O vínculo do navegador pertence ao SUBAGENTE, não ao chat principal nativo. "
                "Não interprete chat_url=null do pai como ausência de sessão do filho. "
                "Nenhum arquivo foi entregue. Verifique o histórico/estado desse subagente antes de repetir.",
                False, additional={"context_id": child_id, "delegation_failed": True})
        finally:
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            self.agent.data.pop(BUSY, None)
