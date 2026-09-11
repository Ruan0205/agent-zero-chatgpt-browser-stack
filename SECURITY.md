# Segurança

## Risco crítico: controle total do host

Esta stack replica uma configuração administrativa. O container `agent-zero` é privilegiado, compartilha os PIDs do host, monta `/` em `/host` com escrita e recebe o socket Docker. Um processo comprometido no container deve ser tratado como comprometimento completo do servidor.

Não publique as portas na Internet. Use firewall, VPN ou proxy reverso com TLS e autenticação forte. O ideal é um host dedicado sem dados pessoais.

## Segredos que nunca devem entrar no Git

- `.env`;
- toda a pasta `data/`;
- perfil Chrome, cookies ou exports de cookies;
- sessões e bancos do WhatsApp;
- chats, memórias, uploads e vault do Agent Zero;
- backups `.tar.gz`;
- `vnc-runtime.json`.

O `.gitignore` cobre esses caminhos, mas revise `git status` e rode uma varredura antes de publicar.

## Recomendações

1. Troque todas as credenciais do `.env.example`.
2. Restrinja 50080, 50081, 50082 e 50022 à LAN/VPN.
3. Use usuário Linux dedicado e permissões `0700` em `data/`.
4. Não reutilize senhas de Google, ChatGPT ou WhatsApp como senha VNC.
5. Mantenha backup criptografado das sessões e teste restauração.
6. Revise cada atualização do Agent Zero: as extensões substituem arquivos internos.
7. Desative o acesso integral removendo `privileged`, `pid: host`, socket Docker e `/host` se ele não for necessário. Algumas ferramentas administrativas deixarão de funcionar.

## Relato de vulnerabilidade

Não abra issue pública contendo credenciais, cookies, telefone, QR code ou logs com dados pessoais. Faça um relatório privado ao mantenedor do fork.
