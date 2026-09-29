from helpers.extension import Extension

class MemoryDeleteContract(Extension):
    async def execute(self, system_prompt=None, **kwargs):
        if isinstance(system_prompt,list):
            system_prompt.append('memory_forget remove por correspondência LITERAL no conteúdo, não por similaridade vetorial. threshold não amplia o alvo. Para mais de um resultado, faça dry_run=true, confira IDs e autorização e passe confirm_ids com apenas os IDs autorizados. Nenhuma cascata automática. memory_delete remove IDs exatos. Nunca trate um marcador único como garantia de busca semântica exata. Ambas as ferramentas criam checkpoint privado antes da exclusão.')
