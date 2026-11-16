# Changelog

## Não lançado

- Novo comando `svclens sync`: escaneia um repositório e leva o resultado para o catálogo, para rodar no CI de um repositório de código. Três modos, escolhidos por `--mode` ou por `sync.mode` no `svclens.config.yaml`: `comment` (relatório em Markdown com o impacto, sem gravar nada), `pr` (branch `svclens/sync-<repositório>` enviada ao remoto) e `push` (commit direto na branch do catálogo, a atualização automática). O scan roda numa cópia, o catálogo só muda se o resultado for válido e se estiver sem alterações pendentes, e um push rejeitado é refeito uma vez com rebase. Com `--base <ref>`, o sync termina sem escanear quando nenhum arquivo de configuração ou manifesto mudou desde a base, e o relatório separa o que a branch mudou do que o catálogo já não tinha.
- `svclens diff` com o catálogo na raiz do repositório lia a versão da base como vazia e mostrava todos os serviços como novos. Corrigido.

## 0.3.0

- Novo comando `svclens impact <serviço>`: mostra o raio de impacto de um serviço, com quem depende dele (direta e indiretamente, por nível), do que ele depende e os times a avisar. Aceita `--depth`, `--format text|markdown|json` e `--max-affected` para falhar no CI quando o impacto passa de um limite.
- Novo campo `role` (`client` ou `server`) nos serviços. O scan marca apps de navegador, desktop e Blazor WebAssembly como `client` e não registra neles relações diretas com banco ou log, que passam por uma camada de servidor. O item vai para o relatório como inconclusivo.
- `svclens validate` avisa quando um serviço `client` depende direto de banco ou de log (`client-direct-access`).

## 0.2.0

- O scan lê `Web.config`, `App.config`, transformações (`Web.Release.config`), NLog, log4net e `appsettings*.json`, e não só o que parece uma URL: connection strings, `appSettings`, endpoints de cliente WCF, servidor SMTP e destinos de log e telemetria (Serilog, NLog, log4net, Application Insights). JSON com comentários e vírgula sobrando é aceito.
- Conexões de banco são identificadas pelo provider (SQL Server, PostgreSQL, MySQL, Oracle, MongoDB, Redis) e viram relações `sql`, `mongodb` ou `redis`. Destinos de log viram `logs`. Com `--create-stubs`, os nós criados são `database` e `logs`, um por host.
- A evidência das dependências ganha `key` (chave ou seção) e `env` (ambiente), exibidos no detalhe do nó.
- Repositórios com vários projetos de aplicação viram um serviço por projeto.
- Relatório do scan com arquivos analisados, padrões encontrados, itens removidos por segurança (só contagem), relações inconclusivas e arquivos ignorados. Novas opções `--json` e `--verbose`.
- URLs de banco em arquivos `.env.example` e similares (`postgres://`, `mongodb://`, `redis://`) passam a ser lidas, sem gravar as credenciais.

## 0.1.1

- Corrige o caminho do comando `svclens` no `package.json`, que o npm precisava corrigir a cada publicação.
- Passa a publicar por tag no GitHub Actions: o workflow envia a versão para a fila do npm (`npm stage publish`) e a publicação final depende da aprovação com a passkey.

## 0.1.0

Primeira versão publicada.

- Catálogo de serviços em YAML com validação (`svclens validate`) e site estático (`svclens build`).
- Visualizador com grafo 2D, modo 3D, tema escuro e claro, busca, filtros, upstream/downstream e exportação em PNG.
- Descoberta automática a partir de repositórios locais ou git (`svclens scan`), com scanners para arquivos de configuração, .NET, Node, OpenAPI e docker-compose.
- Editor local (`svclens serve`) e propostas de mudança por pull request a partir do site publicado.
- `svclens link`, `svclens export --format mermaid` e `svclens diff`.
- Skills para agentes de IA em `skills/`.
