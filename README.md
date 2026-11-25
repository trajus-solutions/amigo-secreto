# Amigo Secreto da Família

Sorteio de amigo secreto online: um link para toda a família, cada pessoa escolhe o próprio nome e vê quem tirou **uma única vez**.
Node 22.13+ com `node:sqlite`, **zero dependências**. Tudo em um servidor pequeno (SQLite em arquivo).

## O que faz
- **Um link só.** Cada pessoa escolhe o nome numa lista, confirma e vê quem tirou. Depois disso o servidor nunca mais devolve o resultado
  (recarregar a página não mostra de novo). O nome sai da lista.
- **Ninguém tira a si mesmo, ninguém é tirado duas vezes.** O sorteio completo é calculado de uma vez ao "Liberar sorteio" (backtracking com CSPRNG),
  então nunca trava no último participante.
- **Regras "X não tira Y"** (valem nos dois sentidos), por exemplo casais ou irmãos. Evita por padrão a troca direta (A↔B).
- **Dois grupos sorteados separadamente:** adultos e crianças (cada um só tira dentro do próprio grupo, mínimo de 3 por grupo; crianças é opcional).
  Na revelação o adulto vê "Amigo Xícara" e a criança vê "Amigo Doce" (edite em `TIPO`, no `server.js`).
- **Observação por pessoa** mostrada a quem a tirar (ex.: restrição alimentar). No cadastro: `Nome | observação`.
- **Painel do organizador em `/admin`** (senha criada no primeiro acesso). O organizador **não vê** quem tirou quem durante o processo.
- **Auditoria:** quando todos revelam, é gerado `data/auditoria/auditoria-amigo-secreto-*.txt` com quem tirou quem (por grupo), baixável no `/admin`.
- Se alguém perder a tela, o organizador pode "liberar de novo": a pessoa vê o **mesmo** resultado (não sorteia outro).

## Rodar
```
node server.js            # http://localhost:3000  (admin em /admin)
node test.js              # teste ponta a ponta (sobe um servidor temporário)
docker compose up -d --build
```
Variáveis: `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (./data), `TRUST_PROXY=1` quando estiver atrás de proxy HTTPS (usa o IP e o protocolo reais e marca cookies como `Secure`).

## Colocar na internet
1. Rode o app (Docker ou `node server.js`) e coloque na frente um proxy com HTTPS (nginx, Caddy…), repassando `X-Forwarded-For` e `X-Forwarded-Proto`, com `TRUST_PROXY=1`.
2. Aponte um (sub)domínio para o servidor. O cadastro/uso é feito só nos dias do sorteio.
3. No primeiro acesso a `/admin`, **crie a senha do organizador antes de divulgar o link**.
4. Cadastre os participantes e as regras, e clique em **Liberar sorteio**. Depois da liberação a lista fica travada.
Se já usa nginx em Docker, veja `ops/docker-compose.shared-network.example.yml`.

## Auditoria no S3 (opcional)
`ops/upload-audit.sh` envia os `.txt` para um bucket (`AUDIT_BUCKET=... ./ops/upload-audit.sh`, bom para cron). Não use bucket com expiração curta
se quiser guardar a auditoria; ou simplesmente baixe o arquivo pelo `/admin`.

## Privacidade
Os nomes ficam só no banco `data/` (ignorado pelo git). A tela pública não expõe regras, grupos, observações nem resultados.
As regras e a auditoria só aparecem para o organizador logado e no arquivo de auditoria.

## Encerrar
Baixe a auditoria, pare o contêiner (`docker compose down`) e remova o domínio/proxy. Apague a pasta `data/` quando não precisar mais dos nomes.
