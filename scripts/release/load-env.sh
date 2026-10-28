# Shared literal .env reader. Never source user configuration as shell code.
ore_load_env() {
  local ore_env_file="$1" ore_env_line ore_env_key ore_env_value ore_env_number=0
  [ -e "$ore_env_file" ] || return 0
  [ -f "$ore_env_file" ] && [ -r "$ore_env_file" ] || { echo "Cannot read ORE environment file: $ore_env_file" >&2; return 1; }
  while IFS= read -r ore_env_line || [ -n "$ore_env_line" ]; do
    ore_env_number=$((ore_env_number + 1))
    ore_env_line="${ore_env_line%$'\r'}"
    # Trim outer whitespace; quoted values retain their inner whitespace.
    ore_env_line="${ore_env_line#"${ore_env_line%%[![:space:]]*}"}"
    ore_env_line="${ore_env_line%"${ore_env_line##*[![:space:]]}"}"
    case "$ore_env_line" in ''|\#*) continue;; esac
    if [[ ! "$ore_env_line" =~ ^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$ ]]; then
      ORE_ENV_ERROR_LINE=$ore_env_number
      echo "Invalid ORE .env assignment at $ore_env_file:$ore_env_number (expected KEY=value)." >&2
      return 1
    fi
    ore_env_key="${BASH_REMATCH[1]}"
    ore_env_value="${BASH_REMATCH[2]}"
    if declare -F ore_accept_env_key >/dev/null && ! ore_accept_env_key "$ore_env_key"; then
      ORE_ENV_ERROR_LINE=$ore_env_number
      echo "Unsupported ORE .env setting at $ore_env_file:$ore_env_number." >&2
      return 1
    fi
    if [[ "$ore_env_value" == \"*\" && ${#ore_env_value} -ge 2 ]] || [[ "$ore_env_value" == \'*\' && ${#ore_env_value} -ge 2 ]]; then
      ore_env_value="${ore_env_value:1:${#ore_env_value}-2}"
    fi
    # Existing environment (even an empty value) takes precedence.
    if [ "${!ore_env_key+x}" != x ]; then
      export "$ore_env_key=$ore_env_value"
    fi
  done < "$ore_env_file"
}
