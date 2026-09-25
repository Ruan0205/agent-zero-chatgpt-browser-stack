'use strict';

// A request to build an environment is an Agent Zero task even when its
// documentation mentions images, archives, downloads or output filenames.
// ChatGPT's native artifact path bypasses Agent Zero's tools entirely.
function isInfrastructureWorkflow(text) {
  const opening = String(text || '').slice(0, 1800);
  const setupAction = /\b(?:preparar|prepare|instalar|instale|configurar|configure|validar|valide|montar|monte|construir|construa|set\s*up|install|configure|build)\b/i.test(opening);
  const setupObject = /\b(?:infraestrutura|stack|pipeline|ambiente|environment|workflow|ferramentas|tools|projeto|project|aplica(?:ção|cao)|application)\b/i.test(opening);
  return setupAction && setupObject;
}

function isNativeMediaText(source, extensionPattern) {
  const text=String(source||'').replace(
    /\b(?:não|nao|sem|do not|don't)\s+(?:crie|criar|gere|gerar|edite|editar|modifique|produza|create|generate|edit|modify|produce)(?:\s+(?:nem|ou|or)\s+(?:crie|criar|gere|gerar|edite|editar|modifique|produza|create|generate|edit|modify|produce))?/gi,
    '',
  );
  if(isInfrastructureWorkflow(text) || /\b[A-Za-z0-9._-]+\.(?:feather|iso)\b/i.test(text)) return false;
  const programmingWorkflow=/\b(?:vs\s*code|vscode|workspace|text_editor|terminal|dockerfile|docker\s+compose|compose\.ya?ml|git|commit|projeto|project|c[oó]digo|codebase|aplica(?:ção|cao)|application)\b/i.test(text);
  const explicitVisualMedia=/\b(?:gere|gerar|crie|criar|edite|editar|modifique|produza|generate|create|edit|modify|produce)\b[^.!?\n]{0,140}\b(?:imagem|imagens|foto|fotos|ilustra(?:ção|cao|ções|coes)|image|images|picture|pictures)\b/i.test(text);
  const explicitAttachmentDelivery=/\b(?:anexe|anexo|attachment|baix[aá]vel|downloadable|download|entregue\s+(?:o\s+)?arquivo|retorne\s+(?:o\s+)?arquivo|attach)\b/i.test(text);
  // A workspace/editor task must reach Agent Zero's tools even if it later
  // asks to publish the file. The native media path would skip verification.
  if(/\b(?:workspace|text_editor|vs\s*code|vscode)\b/i.test(text) && !explicitVisualMedia) return false;
  if(programmingWorkflow && !explicitVisualMedia && !explicitAttachmentDelivery) return false;
  const media='(?:imagem|imagens|foto|fotos|ilustra(?:ção|cao|ções|coes)|image|images|picture|pictures|pdf|zip|arquivo|file)';
  const explicitAction=new RegExp(`\\b(?:gere|gerar|crie|criar|edite|editar|modifique|produza|generate|create|edit|modify|produce)\\b[^.!?\\n]{0,140}\\b${media}\\b`,'i');
  const directMake=new RegExp(`\\b(?:faça|faca)\\b\\s+(?:(?:para\\s+mim)\\s+)?(?:(?:uma?|o|a|duas?|dois|esta?|esse?|essa?)\\s+){0,2}\\b${media}\\b`,'i');
  const explicitFilenameGeneration=new RegExp(`\\b(?:gere|gerar|crie|criar|produza|recrie|regenere|generate|create|produce|recreate|regenerate)\\b[^.!?\\n]{0,180}\\b[\\w.-]+\\.${extensionPattern}\\b`,'i');
  return text.split(/(?:[.!?]+\s+|\n+)/).some(clause=>explicitAction.test(clause)||directMake.test(clause)||explicitFilenameGeneration.test(clause));
}

module.exports = { isInfrastructureWorkflow, isNativeMediaText };
