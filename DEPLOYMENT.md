# Instalação numa VPS

Instruções para instalar o painel (`server/`) numa máquina Linux limpa.
Escrito para ser executado passo a passo, do princípio ao fim.

A app Android não se instala por aqui — distribui-se por APK e configura-se à
mão em cada telemóvel (ver §7).

---

## 0. Antes de começar

Precisas de três coisas. Se faltar alguma, **pára e pede-a** em vez de inventar
um valor:

| | Porquê |
|---|---|
| Um domínio ou subdomínio a apontar para o IP da VPS | A app recusa-se a enviar para `http://` — sem TLS não há integração nenhuma |
| Uma senha para o administrador | Usada uma única vez, no primeiro arranque |
| Acesso `sudo` à VPS | Para o serviço e o proxy |

**Verifica primeiro que o DNS já resolve**, senão o Caddy não consegue emitir o
certificado e ficas a depurar a coisa errada:

```bash
dig +short painel.exemplo.ao          # tem de devolver o IP da VPS
curl -s ifconfig.me                   # o IP desta máquina, para comparar
```

---

## 1. Node 22.5 ou superior

O servidor usa `node:sqlite`, que só existe a partir do Node 22.5. Não há
dependências para instalar — nem `npm install`, nem `node_modules`.

```bash
node --version    # se já for >= v22.5, salta este passo
```

Se for mais antigo (o Debian/Ubuntu dos repositórios costuma ser):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

Confirma que o `node:sqlite` está mesmo disponível antes de seguir:

```bash
node -e "require('node:sqlite'); console.log('sqlite ok')"
```

---

## 2. Código e utilizador próprio

O serviço não corre como root. Nem como o teu utilizador.

```bash
sudo useradd --system --home /opt/access --shell /usr/sbin/nologin access
sudo mkdir -p /opt/access
sudo chown access:access /opt/access

sudo -u access git clone https://github.com/Ievegueni/ACCESS.git /opt/access/repo
```

A base de dados fica fora da árvore do git, para um `git pull` nunca lhe tocar:

```bash
sudo -u access mkdir -p /opt/access/dados
```

---

## 3. Primeiro arranque e criação do administrador

`ADMIN_PASS` **só é lida quando a base de dados está vazia**. Depois disso é
ignorada — não serve para repor a senha. Por isso corre-se isto uma vez, à mão,
e confirma-se a mensagem:

```bash
sudo -u access env \
  ADMIN_PASS='<senha-forte-aqui>' \
  DB_PATH=/opt/access/dados/transferencias.db \
  node /opt/access/repo/server/server.js
```

Tem de aparecer:

```
Administrador "admin" criado.
Painel em http://localhost:3000
```

Interrompe com `Ctrl-C`. O utilizador chama-se `admin`; a senha é a que
escolheste. **Não voltes a passar `ADMIN_PASS` a partir daqui** — não faz nada e
só deixa a senha à vista na configuração do serviço.

> Se em vez disso aparecer `Base de dados vazia: define ADMIN_PASS`, é porque a
> variável não chegou ao processo. Se não aparecer mensagem nenhuma sobre o
> administrador, a base de dados já existia.

---

## 4. Serviço systemd

```bash
sudo tee /etc/systemd/system/access-painel.service > /dev/null <<'EOF'
[Unit]
Description=Painel de transferencias Access
After=network.target

[Service]
Type=simple
User=access
WorkingDirectory=/opt/access/repo/server
ExecStart=/usr/bin/node /opt/access/repo/server/server.js
Restart=always
RestartSec=5

Environment=PORT=3000
Environment=DB_PATH=/opt/access/dados/transferencias.db
# Ligado porque ha um proxy a frente: sem isto o limite de tentativas de login
# ve sempre 127.0.0.1 e dez falhas trancam a porta a todos os clientes.
Environment=CONFIAR_PROXY=1

# So precisa de escrever na pasta dos dados.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/access/dados

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now access-painel
sudo systemctl status access-painel --no-pager
```

O serviço escuta em `localhost:3000` e **não deve ser exposto diretamente**.

---

## 5. Caddy: TLS e proxy

O Caddy trata do certificado sozinho, desde que o DNS já aponte para cá.

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
painel.exemplo.ao {
    reverse_proxy localhost:3000

    # O corpo dos pedidos leva dados financeiros e nunca deve ir para os logs.
    # So o essencial para perceber trafego e erros.
    log {
        output file /var/log/caddy/painel.log
        format console
    }
}
EOF

sudo systemctl reload caddy
```

Troca `painel.exemplo.ao` pelo domínio real.

O Caddy já envia `X-Forwarded-Proto: https` e `X-Forwarded-For`, que são o que o
servidor precisa para marcar o cookie de sessão como `Secure` e para contar as
tentativas de login por IP.

### Firewall

```bash
sudo ufw allow 22,80,443/tcp
sudo ufw enable
```

A porta 3000 **não** é aberta: só o Caddy lhe chega.

---

## 6. Verificação

Faz isto todo antes de dar o endereço a alguém. Cada linha apanha uma falha
diferente.

```bash
DOM=https://painel.exemplo.ao

# 1. TLS de pé e a entrada a responder
curl -s -o /dev/null -w "entrada: %{http_code}\n" $DOM/

# 2. Entrar como admin e confirmar que o cookie vem com Secure
curl -s -i -c /tmp/adm -XPOST $DOM/entrar \
  -d 'cliente=admin&senha=<senha>' | grep -i '^set-cookie'
#    -> tem de acabar em "; Secure". Se nao acabar, falta CONFIAR_PROXY ou o
#       proxy nao esta a enviar X-Forwarded-Proto.

# 3. Webhook recusa quem nao tem token
curl -s -o /dev/null -w "sem token: %{http_code}\n" \
  -XPOST $DOM/webhooks/transferencias -d '{}'
#    -> 401

# 4. API de leitura recusa chave invalida
curl -s -o /dev/null -w "chave ma: %{http_code}\n" \
  $DOM/api/v1/transferencias -H 'Authorization: Bearer ak_nao'
#    -> 401

# 5. O painel nao esta aberto a quem nao entrou
curl -s -o /dev/null -w "api sem sessao: %{http_code}\n" $DOM/api/transferencias
#    -> 401
```

E os testes do próprio servidor, que correm contra uma base de dados em memória
e não tocam nos dados reais:

```bash
cd /opt/access/repo/server && node test.js
# -> ok
```

---

## 7. Pôr o primeiro cliente a funcionar

1. Entrar em `https://painel.exemplo.ao` como `admin`.
2. **Novo cliente**: nome, senha, e o **número do telemóvel** que vai fazer as
   transferências para esse cliente.
3. O painel mostra **URL, token e número**. O token aparece **uma única vez** —
   no servidor só fica o `sha256`.
4. No telemóvel desse cliente, ecrã **Painel (webhook)** da app, colar os três.
   Tocar em **Enviar agora** para confirmar a ligação.
5. Confirmar no `/admin` que o cliente aparece com o ponto verde e
   *"recebido há…"*. Enquanto disser *"nunca enviou nada"*, algo está por ligar.

A página `/programadores` é a que se dá ao programador do cliente. Para ela
ficar completa falta definir, no menu do cliente:

- **Formato do SMS de pedido** — o exemplo que ele vai copiar.
- A **chave de leitura** da API, que ele próprio gera nessa página.

---

## Armadilhas

Coisas que partem isto de maneiras difíceis de diagnosticar. Não são teóricas —
estão todas no código.

**Nunca devolver 4xx por um problema transitório teu.** A app trata 4xx como
definitivo e **apaga o payload da fila**; o SMS não volta a chegar e o registo
perde-se para sempre. Se puseres rate limiting, manutenção, ou qualquer filtro à
frente do `/webhooks/transferencias`, devolve `503`, nunca `429` nem `403`.
(`BACKOFFICE.md` §4.)

**Um só processo.** As sessões vivem num `Map` em memória e o SQLite está em modo
de escrita simples. Nada de `cluster`, `pm2 -i`, nem duas instâncias atrás de um
balanceador: sessões perdidas e escritas a competir.

**Reiniciar o serviço fecha todas as sessões.** É o comportamento certo, mas
avisa antes de reiniciar em horário de trabalho.

**A base de dados é um ficheiro.** Cópia de segurança com o serviço a correr:

```bash
sudo -u access sqlite3 /opt/access/dados/transferencias.db \
  ".backup '/opt/access/dados/copia-$(date +%F).db'"
```

Copiar o ficheiro com `cp` enquanto há escritas dá uma cópia corrompida.

**`ADMIN_PASS` não repõe a senha.** Só é lida com a base de dados vazia. Se
perderes a senha do admin, é preciso reescrevê-la na base de dados com o mesmo
formato `scrypt` — ver `cifrar()` em `server.js`.

**Gerar um token novo é destrutivo do lado da app.** O antigo passa a devolver
`401`, que é 4xx, e a app descarta o que tiver em fila. Para suspender um
cliente sem perder nada usa **Desativar**, que devolve `503`.

**Não registes o corpo dos pedidos.** São dados financeiros e os logs costumam
ter retenção e acessos mais largos do que a base de dados.

---

## Atualizar

```bash
cd /opt/access/repo && sudo -u access git pull
cd server && node test.js                              # tem de dizer "ok"
sudo systemctl restart access-painel
```

As migrações de esquema correm sozinhas ao arrancar (`ALTER TABLE ... ADD COLUMN`
com guarda). Faz a cópia de segurança antes, na mesma.

---

## Variáveis de ambiente

| Variável | Omissão | Notas |
|---|---|---|
| `ADMIN_PASS` | — | Só com a base de dados vazia. Não a deixes no ficheiro do serviço |
| `PORT` | `3000` | Só localhost; quem expõe é o proxy |
| `DB_PATH` | `server/transferencias.db` | Põe-na fora da árvore do git |
| `CONFIAR_PROXY` | desligado | `1` **apenas** quando há mesmo um proxy à frente. Em aberto, qualquer um forja o `X-Forwarded-For` e o limite de tentativas deixa de contar |

---

## Se alguma coisa falhar

```bash
sudo journalctl -u access-painel -n 50 --no-pager     # erros do servidor
sudo journalctl -u caddy -n 50 --no-pager             # TLS e proxy
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/   # o servidor em si
```

| Sintoma | Causa provável |
|---|---|
| Página sem estilos | O proxy a servir uma versão em cache — `curl -I $DOM/estilo.css` tem de dar `200 text/css` |
| Cookie sem `Secure` | Falta `CONFIAR_PROXY=1`, ou o proxy não envia `X-Forwarded-Proto` |
| Caddy não emite certificado | DNS ainda não resolve para esta máquina, ou a porta 80 está fechada |
| Cliente sempre em "nunca enviou nada" | URL ou token errados na app, ou o telemóvel sem o serviço de acessibilidade ligado |
| Transferências em "Por atribuir" | O número daquele telemóvel não está registado em nenhum cliente |
