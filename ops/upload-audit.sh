#!/bin/sh
# OPCIONAL: envia para um bucket S3 os arquivos de auditoria que o app gera quando todos já sortearam.
# Uso (ex.: cron a cada 10 min):  AUDIT_BUCKET=meu-bucket /caminho/ops/upload-audit.sh
# Variáveis: AUDIT_BUCKET (obrigatória), AUDIT_DIR (padrão: ../data/auditoria), AUDIT_PREFIX (padrão: audit/amigo-secreto).
# Requer Docker (usa a imagem amazon/aws-cli) e credenciais AWS no ambiente ou uma role na máquina. Idempotente.
set -eu
: "${AUDIT_BUCKET:?defina AUDIT_BUCKET com o nome do bucket S3}"
DIR="${AUDIT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data/auditoria}"
PREFIX="${AUDIT_PREFIX:-audit/amigo-secreto}"
for f in "$DIR"/auditoria-amigo-secreto-*.txt; do
  [ -e "$f" ] || exit 0
  [ -e "$f.enviado" ] && continue
  docker run --rm --network host -v "$DIR":/data amazon/aws-cli \
    s3 cp "/data/$(basename "$f")" "s3://$AUDIT_BUCKET/$PREFIX/$(basename "$f")" --only-show-errors \
    && touch "$f.enviado"
done
