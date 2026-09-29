from helpers.extension import Extension


class EvidenceInstructions(Extension):
    async def execute(self, loop_data=None, **kwargs):
        loop_data.system.append(
            'Validação visual: antes de avaliar/delegar screenshots, confira visual_evidence.valid. '
            'Captura uniforme/vazia não prova que o projeto está funcionando: consulte os diagnostics, '
            'corrija a causa e recapture; não repita recargas sem hipótese nova. '
            'Ao chamar call_subordinate para crítica visual, envie attachments com caminhos EXATOS da referência '
            'e do render atual (ou uma captura que mostre ambos). Nunca procure o upload mais recente. '
            'Carregue essas evidências com vision_load; descreva o que realmente vê e não invente notas '
            'a partir do pedido, código ou nota anterior. Sem comparação visível, reporte não avaliável. '
            'Prefira uma única prancha com referência e render juntos; se houver várias imagens, '
            'carregue essa prancha por último. Descreva a referência e o render separadamente e '
            'confira que sua crítica não atribui à referência detalhes existentes apenas no render. '
            'browser.evaluate usa script; não envie código vazio. O navegador interno roda no servidor Linux, '
            'não na GPU da máquina Windows; WebGL pode exigir renderização por software.')
