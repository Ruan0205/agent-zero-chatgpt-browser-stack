'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isInfrastructureWorkflow, isNativeMediaText } = require('./media-intent');
const ext = '(?:png|jpe?g|webp|gif|pdf|zip|txt)';

test('long infrastructure prompt with negative image instructions stays in Agent Zero', () => {
  const prompt = `Quero que você atue como engenheiro responsável por preparar e validar uma infraestrutura LOCAL de geração de animações/sprites 2D na minha máquina Windows.\nNÃO instalar IA local para gerar a imagem base.\nNão crie dependência de API paga para geração de imagem.\nInstale e configure a stack, documente e valide o pipeline.`;
  assert.equal(isInfrastructureWorkflow(prompt), true);
});

test('direct media creation is not diverted from the native path', () => {
  assert.equal(isInfrastructureWorkflow('Crie uma imagem de um gato em PNG.'), false);
  assert.equal(isInfrastructureWorkflow('Gere um arquivo ZIP baixável.'), false);
  assert.equal(isInfrastructureWorkflow('Edite esta imagem para deixar o fundo azul.'), false);
});

test('native media intent accepts direct requests', () => {
  for (const prompt of ['Crie uma imagem de um gato em PNG.', 'Gere um arquivo ZIP baixável.', 'Edite esta imagem para deixar o fundo azul.', 'Crie o relatorio.pdf para download.']) {
    assert.equal(isNativeMediaText(prompt, ext), true, prompt);
  }
});

test('workspace work and negated creation use Agent Zero tools', () => {
  for (const prompt of [
    'No workspace isolado do chat, crie o arquivo prova-artifact.txt, verifique e publique como anexo baixável.',
    'Sem criar nem editar arquivo, verifique o anexo prova-artifact.txt com a ferramenta de verificação.',
    'Não crie uma imagem; compare a screenshot e faça as correções no código.',
    'Use o VS Code para editar README.md e depois publique o arquivo.',
  ]) assert.equal(isNativeMediaText(prompt, ext), false, prompt);
});
