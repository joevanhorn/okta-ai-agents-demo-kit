# ABOUTME: Okta private_key_jwt client credentials flow for CrewAI Account Risk Monitor.
# ABOUTME: Mints access tokens and decodes scope claims for scope validation.

import os
import json
import uuid
import base64
import time
from typing import Optional

import jwt
import requests
from dotenv import load_dotenv


def _load_config():
    """Load environment variables from .env if not already loaded."""
    load_dotenv()


def _load_private_key() -> str:
    """
    Load the RSA private key PEM from environment or file.

    Priority:
    1. OKTA_PRIVATE_KEY_FILE (path to PEM file)
    2. OKTA_PRIVATE_KEY_PEM (inline PEM string)
    3. SSM Parameter Store (optional fallback if AWS creds available)

    Returns:
        str: Private key in PEM format.

    Raises:
        ValueError: If no private key is found.
    """
    # Try file path first
    key_file = os.environ.get("OKTA_PRIVATE_KEY_FILE")
    if key_file:
        try:
            with open(key_file, "r") as f:
                return f.read()
        except FileNotFoundError:
            raise ValueError(f"Private key file not found: {key_file}")

    # Try inline PEM
    pem = os.environ.get("OKTA_PRIVATE_KEY_PEM")
    if pem:
        return pem

    # Try SSM (optional fallback)
    try:
        return _load_private_key_from_ssm()
    except Exception:
        raise ValueError(
            "No private key found. Set OKTA_PRIVATE_KEY_PEM, OKTA_PRIVATE_KEY_FILE, or AWS credentials for SSM fallback."
        )


def _load_private_key_from_ssm() -> str:
    """
    Load private key from AWS SSM Parameter Store.

    Reads /taskvantage-prod/crewai-monitor/private-key (SecureString).
    Only used if environment variables are absent and AWS credentials are available.

    Returns:
        str: Private key in PEM format.

    Raises:
        Exception: If SSM read fails or boto3 not available.
    """
    try:
        import boto3
        ssm = boto3.client("ssm", region_name="us-east-2")
        response = ssm.get_parameter(
            Name="/taskvantage-prod/crewai-monitor/private-key",
            WithDecryption=True
        )
        return response["Parameter"]["Value"]
    except Exception as e:
        raise Exception(f"Failed to load private key from SSM: {e}")


def ensure_anthropic_key() -> bool:
    """
    Ensure ANTHROPIC_API_KEY is present in the environment.

    If it is already set (env or .env), do nothing. Otherwise fall back to AWS
    SSM Parameter Store at /taskvantage-prod/crewai-monitor/anthropic-api-key
    (SecureString) — the same account/path that holds the agent's private key,
    so a host with the taskvantage AWS profile/role needs no plaintext key on disk.

    Override the parameter name with ANTHROPIC_API_KEY_SSM_PARAM. Returns True if
    the key is in the environment after this call.
    """
    if os.environ.get("ANTHROPIC_API_KEY"):
        return True
    param = os.environ.get(
        "ANTHROPIC_API_KEY_SSM_PARAM",
        "/taskvantage-prod/crewai-monitor/anthropic-api-key",
    )
    try:
        import boto3
        ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "us-east-2"))
        value = ssm.get_parameter(Name=param, WithDecryption=True)["Parameter"]["Value"]
        os.environ["ANTHROPIC_API_KEY"] = value
        return True
    except Exception:
        return False


def get_agent_token(scopes: str) -> str:
    """
    Mint a client_credentials access token using private_key_jwt.

    Builds a JWT assertion signed with RS256 and POSTs to the Okta token endpoint.

    Args:
        scopes: Space-separated scopes to request (e.g., "sfdc:read sfdc:write snow:read").

    Returns:
        str: The access_token from the response.

    Raises:
        ValueError: If required environment variables are missing.
        requests.RequestException: If the token request fails.
    """
    _load_config()

    token_url = os.environ.get("OKTA_TOKEN_URL")
    client_id = os.environ.get("OKTA_CLIENT_ID")
    key_id = os.environ.get("OKTA_KEY_ID")

    if not all([token_url, client_id, key_id]):
        raise ValueError(
            "Missing required environment variables: OKTA_TOKEN_URL, OKTA_CLIENT_ID, OKTA_KEY_ID"
        )

    private_key_pem = _load_private_key()

    # Build JWT assertion
    now = int(time.time())
    claims = {
        "iss": client_id,
        "sub": client_id,
        "aud": token_url,
        "iat": now,
        "exp": now + 300,
        "jti": str(uuid.uuid4()),
    }

    assertion = jwt.encode(
        claims,
        private_key_pem,
        algorithm="RS256",
        headers={"kid": key_id}
    )

    # Request token
    data = {
        "grant_type": "client_credentials",
        "scope": scopes,
        "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        "client_assertion": assertion,
    }

    response = requests.post(token_url, data=data, timeout=10)
    response.raise_for_status()

    token_response = response.json()
    return token_response["access_token"]


def decode_scopes(access_token: str) -> list:
    """
    Decode the scopes granted in an access token (JWT).

    Base64url-decodes the payload without verification and extracts the 'scp' claim.

    Args:
        access_token: The JWT access token.

    Returns:
        list: List of granted scopes (from the 'scp' claim).
    """
    try:
        # Split JWT: header.payload.signature
        parts = access_token.split(".")
        if len(parts) != 3:
            return []

        payload = parts[1]
        # Add padding if needed for base64url decoding
        padding = 4 - (len(payload) % 4)
        if padding != 4:
            payload += "=" * padding

        decoded = base64.urlsafe_b64decode(payload)
        claims = json.loads(decoded)

        # Okta returns 'scp' as a JSON array; some servers use a space-delimited
        # 'scope' string. Handle both.
        scp = claims.get("scp")
        if isinstance(scp, list):
            return scp
        if isinstance(scp, str) and scp:
            return scp.split()
        scope = claims.get("scope", "")
        return scope.split() if isinstance(scope, str) and scope else []
    except Exception:
        return []
