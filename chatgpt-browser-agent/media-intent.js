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

module.exports = { isInfrastructureWorkflow };
