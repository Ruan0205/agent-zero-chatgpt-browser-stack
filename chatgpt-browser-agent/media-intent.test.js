'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isInfrastructureWorkflow } = require('./media-intent');

test('long infrastructure prompt with negative image instructions stays in Agent Zero', () => {
  const prompt = `Quero que você atue como engenheiro responsável por preparar e validar uma infraestrutura LOCAL de geração de animações/sprites 2D na minha máquina Windows.\nNÃO instalar IA local para gerar a imagem base.\nNão crie dependência de API paga para geração de imagem.\nInstale e configure a stack, documente e valide o pipeline.`;
  assert.equal(isInfrastructureWorkflow(prompt), true);
});

test('direct media creation is not diverted from the native path', () => {
  assert.equal(isInfrastructureWorkflow('Crie uma imagem de um gato em PNG.'), false);
  assert.equal(isInfrastructureWorkflow('Gere um arquivo ZIP baixável.'), false);
  assert.equal(isInfrastructureWorkflow('Edite esta imagem para deixar o fundo azul.'), false);
});
