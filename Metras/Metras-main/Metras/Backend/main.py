# METRAS backend (FastAPI)
#
# AI-powered security risk assessment for software requirements. The service:
#   1. validates an uploaded SRS (PDF/TXT) or pasted text and extracts requirements,
#   2. classifies each requirement (security classifier + security posture rules),
#   3. maps risk-indicating requirements to CVEs from the local NVD feed
#      (sentence embeddings + FAISS + CWE-aware re-ranking),
#   4. scores Severity, Impact, Likelihood and Risk Level with explainable formulas,
#   5. re-checks revised requirements and answers project questions (chatbot).
#
# Run:  uvicorn main:app --reload      (API on http://localhost:8000)


# ============================================================================
# 1. IMPORTS
# ============================================================================

import os, json, re
from pathlib import Path
import numpy as np
import pandas as pd
from fastapi import FastAPI, UploadFile, File, Form, Header, HTTPException
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sklearn.pipeline import Pipeline
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sentence_transformers import SentenceTransformer
from langdetect import detect as detect_language, LangDetectException
import faiss
from PyPDF2 import PdfReader
import io
from typing import Any, Dict, List, Tuple
from dotenv import load_dotenv
from openai import OpenAI
import firebase_admin
from firebase_admin import auth as firebase_auth, credentials, firestore
from sklearn.metrics import classification_report


# ============================================================================
# 2. APPLICATION SETUP
# ============================================================================
# Load secrets from Backend/.env and create the API with open CORS for the local frontend.

load_dotenv(Path(__file__).resolve().parent / ".env")
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# 3. CONFIGURATION AND THRESHOLDS
# ============================================================================
# Every tunable value lives here. THRESHOLDS.md explains how each one was chosen.

# Dataset locations (shipped inside Backend/).
BASE_DIR = Path(__file__).resolve().parent
DATASET_PATH = BASE_DIR / "software_requirements_extended.csv"
NVD_PATH = BASE_DIR / "nvdcve-2.0-modified.json"

# Sentence-embedding model for CVE search and duplicate detection; CVE vectors
# are cached on disk (path can be overridden with CVE_EMBED_CACHE).
EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBED_CACHE = os.getenv("CVE_EMBED_CACHE", str(BASE_DIR / "cve_embeddings.npy"))

# Upload limits.
ALLOWED_EXTENSIONS = {".pdf", ".txt"}
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_PDF_PAGES = 100
MAX_REQUIREMENTS = 500

# --- Decision thresholds ---
# Minimum cosine similarity for a CVE to match a risk-indicating requirement.
SIM_THRESHOLD = 0.45

# Lower similarity floor accepted when the CVE also shares a specific CWE.
CWE_ASSISTED_THRESHOLD = 0.35

# Neutral requirements need a stronger match because the CVE is only context.
CONTEXT_THRESHOLD = SIM_THRESHOLD + 0.10

# Cosine similarity at or above which two requirements are duplicates.
DUPLICATE_THRESHOLD = 0.92

# Classifier probability at or above which a requirement is security-related.
SECURITY_THRESHOLD = 0.40

# Minimum requirement-likeness score (0..1) for a line to be kept.
MIN_REQUIREMENT_CONFIDENCE = 0.48

# --- CVE re-ranking ---
# Nearest CVEs fetched from FAISS before re-ranking.
CVE_CANDIDATES = 25

# Bonus when the CVE shares a specific CWE with the requirement's weakness.
CWE_BOOST = 0.12

# Smaller bonus when only a broad CWE (see GENERIC_CWES) is shared.
GENERIC_CWE_BOOST = 0.04

# Bonus per shared security concept (counted up to 3).
CONCEPT_BOOST = 0.03

# Broad CWE ids that say little about the actual weakness.
GENERIC_CWES = {"CWE-20", "CWE-200", "CWE-284", "CWE-693", "CWE-74", "CWE-707"}

# --- Line filters for uploaded documents ---
MIN_LINE_LENGTH = 15
MAX_LINE_LENGTH = 1000
MIN_WORD_COUNT = 4
MIN_ALPHA_RATIO = 0.55


# ============================================================================
# 4. INPUT VALIDATION AND REQUIREMENT EXTRACTION
# ============================================================================
# Turns raw document text into a clean list of requirements: rejects CVs and
# assignment briefs, non-English text and non-requirement lines, and scores how
# requirement-like and how well written each line is.

# Patterns that make a line read like a requirement: normative verb, actor,
# action, measurable target and trigger condition.
NORMATIVE_PATTERNS = [
    r"\bshall\b", r"\bmust\b", r"\bshould\b", r"\bwill\b",
    r"\bis required to\b", r"\bare required to\b", r"\bneeds? to\b",
    r"\bmay not\b", r"\bshall not\b", r"\bmust not\b", r"\bcan\b"
]
ACTOR_PATTERN = re.compile(
    r"\b(system|application|service|software|platform|module|component|api|"
    r"database|server|client|website|portal|administrator|admin|user|customer|"
    r"operator|member|team leader|organization|device)\b", re.IGNORECASE
)
ACTION_PATTERN = re.compile(
    r"\b(allow|provide|display|store|save|encrypt|decrypt|authenticate|authorize|"
    r"validate|verify|log|record|notify|send|generate|create|update|delete|process|"
    r"support|prevent|restrict|deny|protect|maintain|respond|recover|transmit|"
    r"receive|calculate|compare|export|import|upload|download|search|filter|"
    r"assign|approve|reject|require|retain|remove|access|produce|accept)\w*\b",
    re.IGNORECASE,
)
MEASURABLE_PATTERN = re.compile(
    r"\b(within|at least|at most|no more than|less than|greater than|exactly|"
    r"seconds?|minutes?|hours?|days?|milliseconds?|percent|concurrent|uptime|"
    r"availability|maximum|minimum|mb|gb|requests? per)\b|%", re.IGNORECASE
)
CONDITION_PATTERN = re.compile(
    r"\b(if|when|whenever|upon|before|after|during|unless|while)\b", re.IGNORECASE
)

# Headings and phrases that belong to reports or CVs, not requirements.
NON_REQUIREMENT_PATTERN = re.compile(
    r"\b(abstract|introduction|conclusion|references|table of contents|copyright|"
    r"author|prepared by|executive summary|acknowledg(e)?ments?|this report|"
    r"this document describes|curriculum vitae|work experience|education)\b",
    re.IGNORECASE,
)

# Vague words that make a requirement hard to test (quality check).
AMBIGUOUS_TERMS = [
    "fast", "quick", "easy", "simple", "user-friendly", "intuitive",
    "efficient", "sufficient", "appropriate", "adequate", "robust", "soon",
    "regularly", "as needed", "etc.", "and so on", "high quality"
]

# Markers of an uploaded CV/resume or course assignment instead of an SRS.
CV_DOCUMENT_MARKERS = [
    "professional summary", "career objective", "work experience", "employment history",
    "education", "certifications", "technical skills", "soft skills", "leadership",
    "volunteer experience", "volunteering", "linkedin", "curriculum vitae", "resume",
    "bachelor of", "expected graduation", "references available"
]
ASSIGNMENT_DOCUMENT_MARKERS = [
    "assignment", "submission", "submit", "deliverables", "grading", "rubric",
    "marks", "due date", "deadline", "mvp report", "landing page url",
    "presentation", "video must", "script and scenario", "startup domain"
]

#هنا نرفض الملفات اللي متراس ما يسمح فيها
def detect_unrelated_document(text: str) -> Tuple[str, List[str]]:
    """Detect a CV/resume or an assignment brief before extracting requirements.

    Returns (document type, matched markers); an empty type means the text is acceptable.
    """
    lowered = re.sub(r"\s+", " ", str(text).lower())
    cv_hits = [marker for marker in CV_DOCUMENT_MARKERS if marker in lowered]
    assignment_hits = [marker for marker in ASSIGNMENT_DOCUMENT_MARKERS if marker in lowered]

    # An email address or LinkedIn link is extra CV evidence; 3+ signals means a CV.
    contact_hits = int(bool(re.search(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", lowered)))
    contact_hits += int("linkedin.com" in lowered)
    if len(cv_hits) + contact_hits >= 3:
        return "CV/resume", cv_hits[:5]
    # Three or more assignment markers means coursework instructions.
    if len(assignment_hits) >= 3:
        return "assignment/instructions", assignment_hits[:5]
    return "", []


def normalize_requirement_text(line: str) -> str:
    """Remove leading bullets/IDs (e.g. '1.2)', 'REQ-4', '•') and collapse whitespace."""
    line = re.sub(r"^\s*(?:[-*•]+|(?:REQ[-_ ]?)?\d+(?:\.\d+)*[.):\-]?)\s*", "", str(line))
    return re.sub(r"\s+", " ", line).strip()


def requirement_likeness(line: str) -> Tuple[float, List[str]]:
    """Score 0..1 how much a line reads like a requirement, plus the evidence used.

    +0.35 normative verb, +0.20 actor, +0.20 action, +0.12 measurable target,
    +0.06 condition, +0.12 actor and action together; -0.50 report/CV wording,
    -0.25 normative verb with no actor or action.
    """
    text = normalize_requirement_text(line)
    lowered = text.lower()
    evidence = []
    normative = any(re.search(pattern, lowered) for pattern in NORMATIVE_PATTERNS)
    actor = bool(ACTOR_PATTERN.search(text))
    action = bool(ACTION_PATTERN.search(text))
    measurable = bool(MEASURABLE_PATTERN.search(text))
    condition = bool(CONDITION_PATTERN.search(text))
    prose_marker = bool(NON_REQUIREMENT_PATTERN.search(text))

    # Add points for each requirement feature found.
    score = 0.0
    if normative:
        score += 0.35
        evidence.append("normative language")
    if actor:
        score += 0.20
        evidence.append("clear actor")
    if action:
        score += 0.20
        evidence.append("verifiable action")
    if measurable:
        score += 0.12
        evidence.append("measurable constraint")
    if condition:
        score += 0.06
        evidence.append("condition or trigger")
    if actor and action:
        score += 0.12
    # Penalties: report/CV wording, or a normative verb with no actor or action.
    if prose_marker:
        score -= 0.50
        evidence.append("document prose marker")
    if normative and not (actor or action):
        score -= 0.25
    return round(max(0.0, min(score, 1.0)), 3), evidence


def assess_requirement_quality(line: str) -> Dict[str, Any]:
    """Rate clarity, atomicity and testability out of 100 (does not affect risk).

    Each issue deducts points: 85+ Strong, 60-84 Needs Review, below 60 Weak.
    """
    text = normalize_requirement_text(line)
    lowered = text.lower()
    issues = []
    score = 100
    vague = sorted({term for term in AMBIGUOUS_TERMS if term in lowered})
    if vague:
        issues.append("Ambiguous terms: " + ", ".join(vague))
        score -= min(30, 10 + 5 * len(vague))
    if not ACTOR_PATTERN.search(text):
        issues.append("Actor or responsible component is not explicit")
        score -= 15
    if not ACTION_PATTERN.search(text):
        issues.append("Expected system behaviour is not explicit")
        score -= 20
    if not any(re.search(pattern, lowered) for pattern in NORMATIVE_PATTERNS):
        issues.append("Use normative wording such as shall or must")
        score -= 10
    if len(ACTION_PATTERN.findall(text)) >= 3 or len(re.findall(r"\b(and|or)\b", lowered)) >= 3:
        issues.append("May contain multiple requirements; consider splitting it")
        score -= 15
    performance_words = re.search(r"\b(performance|response time|latency|capacity|scalab|available)\w*\b", lowered)
    if performance_words and not MEASURABLE_PATTERN.search(text):
        issues.append("Quality target is not measurable")
        score -= 20
    if re.search(r"\b(it|this|that|they|them)\b", lowered) and not ACTOR_PATTERN.search(text):
        issues.append("Contains an unclear reference or pronoun")
        score -= 10
    score = max(0, score)
    status = "Strong" if score >= 85 else "Needs Review" if score >= 60 else "Weak"
    return {"score": score, "status": status, "issues": issues}


def classify_requirement_type(line: str, is_security: bool) -> str:
    """Return 'Security', the first matching non-functional category, or 'Functional'."""
    lowered = line.lower()
    if is_security:
        return "Security"
    categories = [
        ("Performance", ["response time", "latency", "throughput", "concurrent", "performance"]),
        ("Availability/Reliability", ["uptime", "availability", "recover", "backup", "failover", "reliable"]),
        ("Usability", ["usability", "user-friendly", "accessible", "accessibility", "intuitive"]),
        ("Privacy/Data", ["personal data", "privacy", "retention", "delete data", "consent"]),
        ("Compatibility/Integration", ["integrate", "compatible", "third-party", "api"]),
        ("Maintainability", ["maintain", "configure", "monitor", "diagnostic"]),
    ]
    for category, keywords in categories:
        if any(keyword in lowered for keyword in keywords):
            return category
    return "Functional"


def validate_document(lines):
    """Check the language and keep only lines that are real requirements.

    Returns (is_valid, error_message, valid_lines).
    """
    if not lines:
        return False, "The document appears to be empty. Please upload a file with content.", []

    if len(lines) < 1:
        return False, "No readable text found in the document.", []

    # Detect the language from the first 20 lines (max 5,000 characters).
    sample_text = " ".join(lines[:20])[:5000]
    try:
        lang = detect_language(sample_text)
        if lang != "en":
            lang_names = {
                "ar": "Arabic", "fr": "French", "es": "Spanish",
                "de": "German", "zh-cn": "Chinese", "zh-tw": "Chinese",
                "ja": "Japanese", "ko": "Korean", "pt": "Portuguese",
                "it": "Italian", "ru": "Russian"
            }
            lang_name = lang_names.get(lang, f"non-English (detected: {lang})")
            return False, (
                f"The document appears to be written in {lang_name}. "
                f"Metras currently supports English documents only. "
                f"Please upload a requirements document in English."
            ), []
    except LangDetectException:
        # Language could not be detected (very short text); continue.
        pass

    # Run every line through the filters below; count what is rejected.
    valid_lines = []
    rejected_count = 0
    strong_structure_count = 0

    for line in lines:
        line = normalize_requirement_text(line)

        if not line:
            continue

        # Too short.
        if len(line) < MIN_LINE_LENGTH:
            rejected_count += 1
            continue

        # Too long: probably a paragraph, not one requirement.
        if len(line) > MAX_LINE_LENGTH:
            rejected_count += 1
            continue

        # Too few words.
        words = line.split()
        if len(words) < MIN_WORD_COUNT:
            rejected_count += 1
            continue

        # Mostly digits or symbols (tables, IDs, broken PDF text).
        alpha_ratio = sum(c.isalpha() for c in line) / len(line)
        if alpha_ratio < MIN_ALPHA_RATIO:
            rejected_count += 1
            continue

        # Short ALL-CAPS line: a heading.
        if line.isupper() and len(words) <= 5:
            rejected_count += 1
            continue

        # Page numbers, versions, dates and author lines.
        line_lower = line.lower()
        if re.match(r'^(page\s+\d+|\d+\s+of\s+\d+|version\s+[\d.]+|date:|author:|revision:)', line_lower):
            rejected_count += 1
            continue

        # Not requirement-like enough.
        confidence, _ = requirement_likeness(line)
        if confidence < MIN_REQUIREMENT_CONFIDENCE:
            rejected_count += 1
            continue

        # Count well-structured requirements: actor + action/measure + normative/measure.
        lowered = line.lower()
        has_normative = any(re.search(pattern, lowered) for pattern in NORMATIVE_PATTERNS)
        has_actor = bool(ACTOR_PATTERN.search(line))
        has_action = bool(ACTION_PATTERN.search(line))
        has_measure = bool(MEASURABLE_PATTERN.search(line))
        if has_actor and (has_action or has_measure) and (has_normative or has_measure):
            strong_structure_count += 1

        valid_lines.append(line)

    # Nothing survived the filters.
    if not valid_lines:
        return False, (
            "No valid requirements were found in the document. "
            "Requirements should be clear sentences describing system behavior, "
            "for example: 'The system shall require users to authenticate before accessing data.'"
        ), []

    # Reject if over 70% of lines were dropped and fewer than 3 requirements remain.
    total = len(valid_lines) + rejected_count
    rejection_ratio = rejected_count / total if total > 0 else 0
    if rejection_ratio > 0.70 and len(valid_lines) < 3:
        return False, (
            f"Only {len(valid_lines)} valid requirement(s) were found out of {total} lines. "
            f"Please make sure the document contains software requirements written in English."
        ), []

    # With 5+ lines, at least 35% must pass and 25% of those must be well structured,
    # so a few requirement-like sentences in a CV or report cannot pass the file.
    if total >= 5:
        candidate_ratio = len(valid_lines) / total
        strong_ratio = strong_structure_count / len(valid_lines) if valid_lines else 0
        if candidate_ratio < 0.35 or strong_ratio < 0.25:
            return False, (
                "This file does not appear to be a software requirements document. "
                f"Only {len(valid_lines)} of {total} text sections looked like requirements, "
                "and too few had a clear actor, action, and normative statement. "
                "Please upload an SRS or a TXT/PDF containing explicit system requirements."
            ), []

    return True, None, valid_lines


def extract_requirements(text):
    """Split document text into candidate requirement lines.

    Bullets and requirement IDs become line breaks, and wrapped lines are joined
    back so a multi-line requirement stays one entry.
    """
    # PDF text often puts several bullets on one line; turn bullets and IDs into breaks.
    text = re.sub(r"\s*[•●▪◦]\s*", "\n", text)
    text = re.sub(r"(?<!\w)(?=(?:REQ[-_ ]?)?\d+(?:\.\d+)*[.)]\s+)", "\n", text)
    raw_lines = text.split("\n")
    requirements = []
    current = ""

    for line in raw_lines:
        line = line.strip()
        # A blank line ends the current requirement.
        if not line:
            if current:
                requirements.append(current)
                current = ""
            continue

        # A number, bullet or capital letter starts a new requirement; anything else
        # continues the previous one.
        starts_new = bool(re.match(r'^(\d+[\.\)]\s|[-•*]\s|[A-Z])', line))

        if starts_new and current:
            requirements.append(current)
            current = line
        elif current:
            current += " " + line
        else:
            current = line

    if current:
        requirements.append(current)

    return [r.strip() for r in requirements if r.strip()]


# ============================================================================
# 5. SECURITY POSTURE CLASSIFICATION
# ============================================================================
# A CVE match only means "same security topic", not "this requirement is
# vulnerable". So every requirement is first placed in one posture:
#
#   Risk-indicating     wording introduces or permits a weakness
#                       -> mapped to CVEs and scored from CVSS + keywords
#   Protective control  wording specifies a safeguard or forbids an unsafe
#                       behaviour -> Low risk, never mapped to a CVE
#   Neutral             no security posture -> Low risk; a related CVE is shown
#                       only as context for the feature's attack surface

# One word inside a regex (letters, digits, hyphens, apostrophes).
_WORD = r"[\w'\-]+"


def _rx(*patterns):
    """Compile case-insensitive regexes; '@W' in a pattern stands for one word."""
    return [re.compile(p.replace("@W", _WORD), re.IGNORECASE) for p in patterns]


# Weakness families. Each rule gives the wording that signals the weakness, the
# CWE ids used to match CVEs, a search query describing the weakness, and a
# baseline impact used when no CVE supplies CIA metrics.
WEAKNESS_RULES = [
    {
        "key": "cleartext", "label": "Cleartext storage/transmission",
        "cwes": ["CWE-312", "CWE-319", "CWE-256"], "impact": "High",
        "query": "sensitive information or passwords stored or transmitted in cleartext without encryption",
        "patterns": _rx(
            r"\b(?:plain[ -]?text|clear[ -]?text|unencrypted|unhashed|unsalted)\b",
            r"\b(?:not|never) (?:be )?(?:encrypted|hashed)\b",
            r"\b(?:without|no|lacking|omit\w*) (?:any )?(?:data )?(?:encryption|hashing)\b",
            r"\b(?:shall|must|should|will) not (?:@W ){0,2}?(?:encrypt\w*|hash\w*)\b",
            r"\bnot (?:use|require|apply|implement|enforce) (?:any )?(?:@W )?(?:encryption|hashing)\b",
            r"\b(?:over|via|using|through) (?:plain |unsecured |insecure )?http\b",
        ),
    },
    {
        "key": "hardcoded_credentials", "label": "Hard-coded credentials",
        "cwes": ["CWE-798", "CWE-259"], "impact": "High",
        "query": "hard-coded credentials or embedded default password allow authentication bypass",
        "patterns": _rx(
            r"\bhard[- ]?coded\b",
            r"\bembedded (?:password|credential|secret|api key)s?\b",
            r"\bdefault (?:password|credential)s? (?:(?:is|are) )?(?:used|retained|kept|unchanged)\b",
        ),
    },
    {
        "key": "missing_authentication", "label": "Missing authentication",
        "cwes": ["CWE-306", "CWE-287"], "impact": "High",
        "query": "missing authentication allows unauthenticated remote attackers to access functionality",
        "patterns": _rx(
            r"\b(?:without|no|skip\w*|bypass\w*|disabl\w*|omit\w*) (?:any |the |user |password )*authentication\b",
            r"\b(?:shall|must|should|will) not (?:@W ){0,2}?(?:require|enforce|perform|apply|implement|use|need) "
            r"(?:any |the |user )?(?:authentication|login|credentials|mfa|password)\b",
            r"\b(?:authentication|login|credentials?) (?:is |are |shall be |will be |may be )?(?:optional|not required)\b",
            r"\b(?:anonymous|unauthenticated|guest) (?:users?|access|requests?|clients?) "
            r"(?:can|may|shall be able to|are allowed to|will be able to|shall be allowed to)\b(?: @W){0,3} "
            r"(?:admin\w*|manage|modify|edit|delete|update|configur\w+)",
        ),
    },
    {
        "key": "missing_authorization", "label": "Missing/broken authorization",
        "cwes": ["CWE-862", "CWE-863", "CWE-284"], "impact": "High",
        "query": "missing authorization or improper access control allows users to access or modify other users' data",
        "patterns": _rx(
            r"\b(?:without|no|lack\w* of|skip\w*|bypass\w*) (?:any |proper |role[- ]based |the )*"
            r"(?:authori[sz]ation|access control|permission checks?|role checks?)\b",
            r"\b(?:any|every|all) (?:authenticated |logged[- ]in |registered )?users? "
            r"(?:can|may|shall be able to|are allowed to|will be able to)\b(?: @W){0,4} "
            r"(?:(?:all |any |every )?other users?'?s? (?:data|accounts?|records?|files?|profiles?)"
            r"|all (?:data|records|accounts|files)|admin\w*|unrestricted|everything)",
            r"\b(?:full|unrestricted|unlimited|admin(?:istrator)?) (?:access|privileges?|permissions?) "
            r"(?:to|for) (?:all|every|any) users?\b",
            r"\b(?:privilege escalation|broken access control|insecure direct object reference|idor)\b",
            r"\b(?:publicly accessible|world[- ]readable|open to (?:the )?public) "
            r"(?:database|api|admin|endpoint|storage|bucket|files?|data|backup)s?\b",
        ),
    },
    {
        "key": "injection", "label": "Injection / improper input handling",
        "cwes": ["CWE-89", "CWE-79", "CWE-78", "CWE-94", "CWE-20"], "impact": "High",
        "query": "improper input validation allows SQL injection or cross-site scripting by remote attackers",
        "patterns": _rx(
            r"\b(?:sql|command|code|ldap|xpath|os command|html|script|template) injection\b",
            r"\b(?:xss|cross[- ]site scripting)\b",
            r"\bremote code execution\b",
            r"\b(?:without|no|skip\w*|omit\w*|lack\w* of) (?:any |proper |server[- ]side |client[- ]side )*"
            r"(?:input )?(?:validation|sanitiz\w+|sanitis\w+|escaping|encoding|filtering)\b",
            r"\b(?:unvalidated|unsanitized|unsanitised|unescaped|unfiltered)\b",
            r"\b(?:directly|straight) (?:in|into) (?:the |a |an )?(?:sql |database |db |query|command|shell|page|html|dom|template)",
            r"\bconcatenat\w+ (?:@W ){0,4}(?:into|in|with) (?:a |the )?(?:sql |database )?quer(?:y|ies)\b",
        ),
    },
    {
        "key": "path_upload", "label": "Path traversal / unrestricted upload",
        "cwes": ["CWE-22", "CWE-434"], "impact": "High",
        "query": "path traversal or unrestricted file upload allows attackers to read or write arbitrary files",
        "patterns": _rx(
            r"\b(?:path|directory|dot[- ]dot[- ]slash) traversal\b",
            r"\b(?:unrestricted|arbitrary|any) file (?:upload|type|extension)s?\b",
            r"\bupload\w* (?:of )?(?:any|all|arbitrary|executable) (?:file|type)s?\b",
            r"\bfiles? of any (?:type|format|extension)\b",
            r"\b(?:without|no) (?:checking|validating|verifying|restricting|scanning) (?:the )?(?:file|upload|extension|mime|content)\b",
        ),
    },
    {
        "key": "brute_force_dos", "label": "No brute-force / resource limits",
        "cwes": ["CWE-307", "CWE-770", "CWE-400"], "impact": "Medium",
        "query": "no limit on authentication attempts or requests allows brute force or denial of service",
        "patterns": _rx(
            r"\bunlimited (?:login |password |failed )?(?:attempts?|retries|requests?|uploads?|connections?)\b",
            r"\bany number of (?:login |password |failed )?attempts\b",
            r"\b(?:no|without) (?:any )?(?:rate[- ]?limit\w*|throttl\w*|account lock\w*|lockout|captcha|request limit\w*|"
            r"brute[- ]force (?:protection|prevention))\b",
            r"\bno (?:limit|maximum|cap) (?:on|for) (?:the )?(?:number of |size of )?(?:login |failed |password )?"
            r"(?:attempts?|requests?|uploads?|size)\b",
        ),
    },
    {
        "key": "weak_credentials", "label": "Weak credentials / password policy",
        "cwes": ["CWE-521", "CWE-307"], "impact": "Medium",
        "query": "weak password requirements allow attackers to guess user credentials",
        "patterns": _rx(
            r"\b(?:weak|simple|short|common|guessable|blank|empty) (?:passwords?|passphrases?|pins?|secrets?)\b",
            r"\b(?:no|without|lack\w* of) (?:@W ){0,2}password (?:policy|policies|complexity|strength|length)\b",
        ),
    },
    {
        "key": "weak_crypto", "label": "Weak/custom cryptography",
        "cwes": ["CWE-327", "CWE-328", "CWE-326"], "impact": "High",
        "query": "use of a broken or weak cryptographic algorithm or hash allows attackers to recover protected data",
        "patterns": _rx(
            r"\b(?:md5|sha-?1|rc4|3?des|ecb mode)\b",
            r"\b(?:weak|broken|obsolete|deprecated) (?:encryption|cipher|hash\w*|algorithm|crypto\w*)\b",
            r"\b(?:custom|proprietary|home[- ]?grown|home[- ]?made) (?:encryption|cryptograph\w*|cipher|hash\w*)\b",
        ),
    },
    {
        "key": "session_web", "label": "Session / cookie / CSRF weakness",
        "cwes": ["CWE-613", "CWE-384", "CWE-352", "CWE-1004"], "impact": "Medium",
        "query": "insufficient session expiration or missing CSRF protection allows session hijacking",
        "patterns": _rx(
            r"\b(?:no|without|missing|lack\w* of|disabl\w*) (?:@W )?(?:session (?:timeout|expir\w+|invalidation)|"
            r"csrf(?: protection| tokens?)?|httponly|secure flag|cookie flags?)\b",
            r"\b(?:sessions?|tokens?|cookies?) (?:(?:shall|will|must|should) )?(?:never|not) (?:expire|time ?out)\b",
            r"\binsecure cookies?\b",
            r"\bsession (?:id|identifier|token)s? (?:in|via|through) (?:the )?(?:url|query string)\b",
        ),
    },
    {
        "key": "logging_exposure", "label": "Missing logging / information exposure",
        "cwes": ["CWE-778", "CWE-532", "CWE-209", "CWE-200"], "impact": "Medium",
        "query": "sensitive information exposure through log files or verbose error messages",
        "patterns": _rx(
            r"\b(?:no|without|disabl\w*|omit\w*) (?:@W )?(?:logging|audit(?:ing)?(?: trail| log)?s?|monitoring)\b",
            r"\b(?:log|logs|logged|print\w*|dump\w*) (?:@W ){0,3}(?:in|as) (?:plain ?text|clear ?text)\b",
            r"\b(?:logs?|log files?) (?:shall |will |may |can )?(?:contain|include|show|expose) (?:@W ){0,2}"
            r"(?:passwords?|credentials?|secrets?|tokens?|card numbers?|cvv|ssn)\b",
            r"\b(?:display|show|return|expos|reveal|print)\w* (?:@W ){0,3}(?:stack ?traces?|verbose errors?|"
            r"debug (?:information|output|messages?)|internal error details?|database errors?|sql errors?)\b",
            r"\bverbose error\b",
            r"\b(?:stack ?traces?|verbose errors?|debug (?:information|output|messages?)|internal error details?|"
            r"database errors?|sql errors?) (?:(?:shall|must|should|will|can|may) )?(?:be )?"
            r"(?:shown|displayed|returned|exposed|revealed|visible|printed)\b",
        ),
    },
    {
        "key": "outdated_components", "label": "Outdated/vulnerable components",
        "cwes": ["CWE-1104", "CWE-937"], "impact": "Medium",
        "query": "use of outdated or vulnerable third-party component with known vulnerabilities",
        "patterns": _rx(
            r"\b(?:outdated|unsupported|end[- ]of[- ]life|unpatched|vulnerable) (?:@W ){0,2}(?:librar\w+|component\w*|"
            r"framework\w*|software|version\w*|package\w*|dependenc\w+|plugin\w*|module\w*|systems?|operating systems?)\b",
            r"\b(?:no|without) (?:(?:regular|security|automatic|timely) )+(?:updates?|patch(?:es|ing)?)\b",
        ),
    },
    {
        "key": "integrity", "label": "Missing integrity verification",
        "cwes": ["CWE-345", "CWE-353", "CWE-494"], "impact": "Medium",
        "query": "missing integrity or signature verification allows tampered code or data to be accepted",
        "patterns": _rx(
            r"\b(?:no|without|skip\w*|omit\w*|lack\w* of) (?:any |a |the )?(?:integrity|signature|checksum|hash|certificate) "
            r"(?:check\w*|verification|validation|validat\w+|verif\w+)\b",
            r"\b(?:unsigned|unverified) (?:updates?|code|packages?|firmware|downloads?|plugins?|binaries|software)\b",
            r"\bdisabl\w* (?:certificate|ssl|tls) (?:validation|verification|checks?)\b",
        ),
    },
    {
        "key": "protection_disabled", "label": "Security protection disabled",
        "cwes": ["CWE-693"], "impact": "High",
        "query": "protection mechanism failure security features disabled",
        "patterns": _rx(
            r"\b(?:disable|turn off|bypass|skip) (?:all |the )?(?:security|firewall|antivirus|protection)\b",
            r"\b(?:no|without) (?:a )?firewall\b",
            r"\ballow all (?:traffic|requests|connections|origins|users)\b",
        ),
    },
]

# Weakness rule lookup by key.
WEAKNESS_BY_KEY = {rule["key"]: rule for rule in WEAKNESS_RULES}

# Attack surfaces of ordinary features. A plain feature such as "users log in" is
# not a flaw (it stays Low) but is exposed to known attacks, so a related CVE is
# shown as awareness context. Used only for Neutral requirements.
ATTACK_SURFACES = [
    {"key": "authentication", "label": "Authentication / login",
     "cwes": ["CWE-287", "CWE-306", "CWE-307", "CWE-521"],
     "query": "authentication bypass or missing multi-factor authentication allows attackers to log in as another user",
     "patterns": _rx(r"\b(?:log ?in|log ?on|sign ?in|login|sign ?up|register\w*|credentials?|passwords?|passcode)\b")},
    {"key": "password_reset", "label": "Password reset / recovery",
     "cwes": ["CWE-640", "CWE-620", "CWE-287"],
     "query": "password reset flaw allows account takeover by unauthenticated attackers",
     "patterns": _rx(r"\b(?:reset|forgot\w*|recover\w*)\b(?: @W){0,5} password",
                     r"\bpassword(?: @W){0,5} (?:reset|recovery)\b")},
    {"key": "file_upload", "label": "File upload / download",
     "cwes": ["CWE-434", "CWE-22"],
     "query": "unrestricted file upload or path traversal allows attackers to write or read arbitrary files",
     "patterns": _rx(r"\b(?:upload\w*|attach\w*|download\w*)\b")},
    {"key": "user_management", "label": "User / role management",
     "cwes": ["CWE-862", "CWE-863", "CWE-269", "CWE-284"],
     "query": "improper access control or privilege escalation in user account management",
     "patterns": _rx(r"\b(?:administrators?|admins?|user accounts?|roles?|permissions?|privileges?)\b")},
    {"key": "session", "label": "Session management",
     "cwes": ["CWE-613", "CWE-384", "CWE-352"],
     "query": "session fixation or insufficient session expiration allows session hijacking",
     "patterns": _rx(r"\bsessions?\b", r"\bremember me\b")},
    {"key": "user_input", "label": "User input / search / forms",
     "cwes": ["CWE-89", "CWE-79", "CWE-20"],
     "query": "improper input validation allows SQL injection or cross-site scripting through form or search fields",
     "patterns": _rx(r"\b(?:search\w*|quer(?:y|ies)|submit\w*|forms?|comments?|free[- ]text|input fields?)\b")},
    {"key": "sensitive_data", "label": "Personal / sensitive data",
     "cwes": ["CWE-200", "CWE-312", "CWE-359"],
     "query": "exposure of sensitive personal information to an unauthorized actor",
     "patterns": _rx(r"\b(?:personal (?:data|information)|payment\w*|credit cards?|confidential|medical|financial|profiles?|"
                     r"sensitive (?:data|information))\b")},
    {"key": "api_integration", "label": "API / third-party integration",
     "cwes": ["CWE-918", "CWE-287", "CWE-1104"],
     "query": "API endpoint with improper authentication or server-side request forgery in third-party integration",
     "patterns": _rx(r"\b(?:apis?|web ?services?|integrat\w+|third[- ]party)\b")},
]


def detect_attack_surfaces(text):
    """Return the attack surfaces a requirement touches (keys, labels, CWEs, search queries)."""
    hits = [s for s in ATTACK_SURFACES if any(rx.search(text) for rx in s["patterns"])]
    return {
        "keys": [s["key"] for s in hits],
        "labels": [s["label"] for s in hits],
        "cwes": list(dict.fromkeys(c for s in hits for c in s["cwes"])),
        "queries": [s["query"] for s in hits],
    }


# Wording that describes a safeguard (encryption, MFA, validation, access control...).
CONTROL_PATTERNS = _rx(
    r"\b(?:encrypt\w*|hash(?:es|ed|ing)?|salt(?:ed|ing)?|bcrypt|argon2|scrypt|pbkdf2|aes[- ]?\d*|tls(?: ?1\.[23])?|ssl|https|hsts)\b",
    r"\bauthenticat\w*",
    r"\bauthori[sz]\w*",
    r"\b(?:multi|two)[- ]?factor\b|\bmfa\b|\b2fa\b|\bone[- ]time (?:password|code|passcode)s?\b|\botp\b",
    r"\b(?:sanitiz|sanitis|parameteri[sz]|escap|whitelist|allow[- ]?list|blocklist|deny[- ]?list)\w*",
    r"\b(?:input|server[- ]side|client[- ]side|schema|file type|mime type|extension) (?:validation|verification)\b",
    r"\bvalidat\w+ (?:all |the |user |any )*(?:input|data|request|parameter|file|upload)s?\b",
    r"\bvalidat\w+(?: \w+){0,4} (?:uploaded )?(?:files?|file types?|mime types?|extensions?)\b",
    r"\b(?:role[- ]based|attribute[- ]based|rbac|abac|least[- ]privilege|access[- ]control|access control list|acl)\b",
    r"\b(?:rate[- ]?limit\w*|throttl\w*|account lock\w*|lockout|captcha|brute[- ]force (?:protection|prevention))\b",
    r"\block(?:s|ed)? (?:out )?(?:the |a |that |user )?(?:account|user)s?\b",
    r"\b(?:audit (?:log|trail)s?|security (?:log|event|monitoring)\w*|intrusion detection|firewall|waf|antivirus|"
    r"anti-malware|penetration test\w*|vulnerability scan\w*|security audit\w*)\b",
    r"\b(?:csrf (?:token|protection)s?|content security policy|csp|httponly|secure cookies?|same[- ]?site)\b",
    r"\bsession (?:timeout|expir\w+|invalidat\w+)\b",
    r"\b(?:sessions?|tokens?) (?:(?:shall|must|should|will) )?(?:expire|time ?out|be (?:invalidated|revoked))\b",
    r"\b(?:invalidat|revok|expir)\w* (?:the )?(?:session|token)s?\b",
    r"\bautomatic(?:ally)? (?:log ?out|logged out|sign ?out)\b",
    r"\b(?:stack ?traces?|verbose errors?|debug (?:information|output|messages?)|internal error details?|"
    r"database errors?|sql errors?) (?:(?:shall|must|should|will) )?(?:never|not) (?:be )?"
    r"(?:shown|displayed|returned|exposed|revealed|printed)\b",
    r"\b(?:digital signature|checksum|integrity (?:check|verification)|code signing)\b",
    r"\bpassword (?:policy|complexity|strength|length)\b|\bstrong passwords?\b",
    r"\bmask\w* (?:@W ){0,2}(?:data|numbers?|passwords?|inputs?|credentials?|tokens?|pii|secrets?)\b|\bredact\w*",
    r"\bonly(?: @W){0,4}? (?:registered|authenticated|authori[sz]ed|verified|approved|permitted|admin\w*)\b",
    # A generic verb (restrict, protect, log...) counts only when it acts on a security object.
    r"\b(?:restrict|prevent|deny|prohibit|protect|secure|safeguard|block|limit|reject|verify|validate|log(?!\s?(?:in|on|into|out)\b)|monitor|"
    r"record|enforce|require)\w*\b(?: @W){0,5}? (?:passwords?|credentials?|identity|tokens?|sessions?|otp|sensitive|"
    r"confidential|personal data|permissions?|privileges?|unauthori[sz]ed|malicious|attacks?|intrusions?|breach\w*|"
    r"tamper\w*|vulnerabilit\w+|threats?)\b",
)

# Wording around a weakness that turns it into a prohibition, e.g. "must not store
# passwords in plaintext" or "XSS shall be prevented" - a control, not a flaw.
PRE_PROHIBITION = _rx(
    r"\b(?:shall|must|should|will|may|can|does|do|is|are) (?:not|never)\b",
    r"\b(?:never|no|zero)\b(?:\W+\w+){0,2}\W*$",
    r"\b(?:prevent|prohibit|forbid|disallow|avoid|block|reject|refuse|deny|eliminat|mitigat|protect|defend|guard|"
    r"safeguard|resist|detect|remediat)\w*\b",
    r"\bfree (?:of|from)\b",
    r"\bnot (?:be )?(?:allowed|permitted|able) to\b",
    r"\bunder no circumstances\b",
    r"\bensure (?:that )?no\b",
    r"\bagainst\b",
)
POST_PROHIBITION = re.compile(
    r"\b(?:(?:shall|must|should|will|can|may) not (?:be )?(?:allowed|permitted|possible|exist|occur|used|stored|"
    r"present|accepted|tolerated|enabled|supported)|(?:shall|must|should|will) be (?:prevented|blocked|rejected|"
    r"mitigated|avoided|prohibited|forbidden|disallowed|eliminated|detected|stopped|refused|removed))\b",
    re.IGNORECASE,
)

# Whitespace normaliser and clause splitter used for the prohibition check.
_WS = re.compile(r"\s+")
_CLAUSE_SPLIT = re.compile(r"[.;:!?]|\b(?:but|however|although|whereas|while)\b", re.IGNORECASE)


def _is_prohibited_hazard(text, match):
    """Return True if the matched weakness wording sits inside a prohibition.

    Checks up to 140 characters before and 120 after the match, within the same clause.
    """
    before = _CLAUSE_SPLIT.split(text[:match.start()])[-1][-140:]
    after = _CLAUSE_SPLIT.split(text[match.end():], maxsplit=1)[0][:120]
    return any(rx.search(before) for rx in PRE_PROHIBITION) or bool(POST_PROHIBITION.search(after))


def classify_security_posture(requirement):
    """Classify a requirement as 'Risk-indicating', 'Protective control' or 'Neutral'.

    Returns a dict with:
      label          the posture
      evidence       readable reasons (the matched wording)
      weakness_keys  weakness families introduced (risk-indicating only)
      cwes           CWE ids implied by those weaknesses (used for CVE matching)
      confidence     heuristic 0..0.95 confidence in the label
      surface_*      attack surfaces touched (neutral only), e.g. login
    """
    text = _WS.sub(" ", str(requirement)).strip()

    # 1) Find weakness wording; split it into real risks and prohibited hazards.
    risk_hits, prohibited_hits, seen = [], [], set()
    for rule in WEAKNESS_RULES:
        for rx in rule["patterns"]:
            for m in rx.finditer(text):
                token = (rule["key"], m.group(0).lower())
                if token in seen:
                    continue
                seen.add(token)
                hit = {"key": rule["key"], "text": m.group(0).lower()}
                (prohibited_hits if _is_prohibited_hazard(text, m) else risk_hits).append(hit)

    # 2) Collect wording that describes safeguards.
    controls = []
    for rx in CONTROL_PATTERNS:
        m = rx.search(text)
        if m and m.group(0).lower() not in controls:
            controls.append(m.group(0).lower())

    # 3) Decide the posture. Confidence grows with the amount of evidence.
    risk_keys = list(dict.fromkeys(h["key"] for h in risk_hits))
    cwes = list(dict.fromkeys(c for k in risk_keys for c in WEAKNESS_BY_KEY[k]["cwes"]))

    if risk_hits:
        label = "Risk-indicating"
        evidence = [f"risk: {WEAKNESS_BY_KEY[h['key']]['label']} ('{h['text']}')" for h in risk_hits]
        confidence = 0.65 + 0.10 * min(len(risk_hits), 3)
        # Mixed wording: a control is mentioned but a weakness is still introduced.
        if controls:
            evidence.append("also mentions a control: " + ", ".join(controls[:3]))
            confidence -= 0.10
    elif prohibited_hits or controls:
        label = "Protective control"
        evidence = [f"prohibits: {WEAKNESS_BY_KEY[h['key']]['label']} ('{h['text']}')" for h in prohibited_hits]
        evidence += [f"control: {c}" for c in controls[:4]]
        confidence = 0.60 + 0.10 * min(len(prohibited_hits) + len(controls), 3)
    else:
        label, evidence, confidence = "Neutral", [], 0.50

    # Attack surfaces are only needed for neutral requirements.
    surfaces = detect_attack_surfaces(text) if label == "Neutral" else {"keys": [], "labels": [], "cwes": [], "queries": []}
    return {
        "label": label,
        "evidence": evidence,
        "weakness_keys": risk_keys,
        "cwes": cwes,
        "confidence": round(min(confidence, 0.95), 2),
        "surface_keys": surfaces["keys"],
        "surface_labels": surfaces["labels"],
        "surface_cwes": surfaces["cwes"],
        "surface_queries": surfaces["queries"],
    }


# ============================================================================
# 6. RISK SCORING FORMULAS
# ============================================================================
# Severity, Impact, Likelihood and Risk Level. All are rule-based (not trained)
# so every score can be explained from the CVE's CVSS data and the wording.

# Severity keywords: wording that on its own justifies a minimum severity,
# even when the matched CVE's CVSS score is lower.
CRITICAL_KEYWORDS = [
    "plain text", "plaintext", "no encryption", "without encryption",
    "sql injection", "without validation", "without sanitiz",
    "no authentication", "hardcoded", "hard-coded",
    "command injection", "remote code execution", "unencrypted"
]
HIGH_KEYWORDS = [
    "xss", "cross-site scripting", "no access control", "path traversal",
    "no rate limit", "unlimited attempt", "privilege escalation",
    "broken access", "no authorization"
]
MEDIUM_KEYWORDS = [
    "weak password", "no mfa", "missing mfa", "insecure cookie",
    "no csrf", "missing csrf", "verbose error", "outdated library"
]

# Likelihood keywords. Insecure practices make exploitation likely (weight 1.0)...
HIGH_LIKELIHOOD_KEYWORDS = [
    "no validation", "no sanitiz", "without validation", "without sanitiz",
    "plain text", "plaintext", "no encryption", "without encryption",
    "no authentication", "without authentication", "no authorization",
    "hardcoded", "hard-coded", "no rate limit", "unlimited attempt",
    "no access control", "without access control", "directly into",
    "unencrypted", "no mfa", "without mfa", "no password policy",
    "no session", "without session", "no firewall", "no logging"
]

# ...weaker or partial practices (weight 0.6). Anything else gets 0.5.
MEDIUM_LIKELIHOOD_KEYWORDS = [
    "should encrypt", "should validate", "should authenticate",
    "weak password", "simple password", "basic auth", "http ",
    "no csrf", "missing csrf", "no httponly", "insecure cookie",
    "outdated", "third party", "third-party", "external library"
]


def map_impact_value(val):
    """Convert a CVSS CIA value to a number: HIGH/COMPLETE=3, LOW/PARTIAL=2, NONE or missing=1."""
    if not val: return 1.0
    val = str(val).upper()
    if val in ["HIGH", "COMPLETE"]:    return 3.0
    if val in ["LOW", "PARTIAL"]:      return 2.0
    if val in ["NONE"]:                return 1.0
    return 1.0


# Numeric order of impact levels, used to keep the higher of two impacts.
IMPACT_SCALE = {"Low": 1, "Medium": 2, "High": 3}


def formula_severity(cvss_score, requirement, security_posture="Neutral"):
    """Severity = the worse of the CVSS band and the keyword severity.

    CVSS bands are the official NVD scale: 9.0+ Critical, 7.0-8.9 High,
    4.0-6.9 Medium, below 4.0 Low. Keywords can only raise the level, so a
    loosely matched low-score CVE cannot under-rate e.g. "plaintext passwords".
    Protective and neutral requirements are always Low.
    """
    # Protective/neutral wording never inherits a vulnerability's CVSS score.
    if security_posture != "Risk-indicating":
        return "Low"

    req_lower = requirement.lower()

    # Keyword-based severity.
    if any(kw in req_lower for kw in CRITICAL_KEYWORDS):
        keyword_severity = "Critical"
    elif any(kw in req_lower for kw in HIGH_KEYWORDS):
        keyword_severity = "High"
    elif any(kw in req_lower for kw in MEDIUM_KEYWORDS):
        keyword_severity = "Medium"
    else:
        keyword_severity = None

    # CVSS-based severity (NVD qualitative bands).
    cvss_severity = "Low"
    if cvss_score is not None:
        try:
            score = float(cvss_score)
            if score >= 9.0:   cvss_severity = "Critical"
            elif score >= 7.0: cvss_severity = "High"
            elif score >= 4.0: cvss_severity = "Medium"
            else:              cvss_severity = "Low"
        except: pass

    # Keep whichever is more severe.
    scale = {"Critical": 4, "High": 3, "Medium": 2, "Low": 1}
    if keyword_severity:
        if scale[keyword_severity] > scale[cvss_severity]:
            return keyword_severity
    return cvss_severity


def formula_likelihood(requirement, cve_obj):
    """Likelihood = (CVE exploitability / scale maximum) x keyword weight.

    Exploitability maximum is 3.9 in CVSS v3 and 10 in v2, so the ratio is 0..1
    (no CVE -> 2.0 on the v3 scale). Keyword weight: 1.0 insecure practice,
    0.6 weaker practice, 0.5 otherwise. Score >= 0.65 High, >= 0.35 Medium, else Low.
    """
    # Defaults when no CVE is available.
    exploitability  = 2.0
    max_exploit     = 3.9

    # Prefer CVSS v3.x exploitability; fall back to v2.
    if cve_obj:
        metrics = cve_obj.get("metrics", {})
        for key in ["cvssMetricV31", "cvssMetricV30"]:
            arr = metrics.get(key)
            if arr and len(arr) > 0:
                exp = arr[0].get("exploitabilityScore")
                if exp is not None:
                    exploitability = float(exp)
                    max_exploit    = 3.9
                    break
        else:
            arr = metrics.get("cvssMetricV2")
            if arr and len(arr) > 0:
                exp = arr[0].get("exploitabilityScore")
                if exp is not None:
                    exploitability = float(exp)
                    max_exploit    = 10.0

    # Normalise to 0..1.
    exploitability_ratio = min(exploitability / max_exploit, 1.0)

    # Weight by how directly the requirement describes an insecure practice.
    req_lower = requirement.lower()
    if any(kw in req_lower for kw in HIGH_LIKELIHOOD_KEYWORDS):
        keyword_weight = 1.0
    elif any(kw in req_lower for kw in MEDIUM_LIKELIHOOD_KEYWORDS):
        keyword_weight = 0.6
    else:
        keyword_weight = 0.5

    # Combine and convert to a level.
    score = exploitability_ratio * keyword_weight

    if score >= 0.65: return "High"
    if score >= 0.35: return "Medium"
    return "Low"


def _cvss_impact(cve_obj):
    """Impact from the matched CVE's Confidentiality, Integrity and Availability values.

    Average of the three (High=3, Low=2, None=1): above 2.5 High, above 1.5 Medium,
    otherwise Low. Low when there is no CVE.
    """
    if not cve_obj:
        return "Low"

    metrics = cve_obj.get("metrics", {})

    # CVSS v3.x first.
    for key in ["cvssMetricV31", "cvssMetricV30"]:
        arr = metrics.get(key)
        if arr and len(arr) > 0:
            data = arr[0].get("cvssData", {})
            c = map_impact_value(data.get("confidentialityImpact"))
            i = map_impact_value(data.get("integrityImpact"))
            a = map_impact_value(data.get("availabilityImpact"))
            avg = (c + i + a) / 3.0
            if avg > 2.5: return "High"
            if avg > 1.5: return "Medium"
            return "Low"

    # Fall back to CVSS v2.
    arr = metrics.get("cvssMetricV2")
    if arr and len(arr) > 0:
        data = arr[0].get("cvssData", {})
        c = map_impact_value(data.get("confidentialityImpact"))
        i = map_impact_value(data.get("integrityImpact"))
        a = map_impact_value(data.get("availabilityImpact"))
        avg = (c + i + a) / 3.0
        if avg > 2.5: return "High"
        if avg > 1.5: return "Medium"
        return "Low"

    return "Low"


def formula_impact(cve_obj, weakness_keys=None):
    """Impact = the higher of the CVE's CIA impact and the weakness baseline impact.

    The baseline stops a loosely matched, low-impact CVE from under-rating a
    requirement such as "store passwords in plaintext", and still gives a
    sensible impact when no CVE was matched.
    """
    cvss_impact = _cvss_impact(cve_obj)
    baseline = "Low"
    for key in weakness_keys or []:
        rule = WEAKNESS_BY_KEY.get(key)
        if rule and IMPACT_SCALE[rule["impact"]] > IMPACT_SCALE[baseline]:
            baseline = rule["impact"]
    return cvss_impact if IMPACT_SCALE[cvss_impact] >= IMPACT_SCALE[baseline] else baseline


def formula_risk_matrix(impact, likelihood):
    """Risk level from the standard 3x3 risk matrix: Impact x Likelihood.

    Low=1, Medium=2, High=3, so the score is 1..9:
    9 Critical, 6 High, 3-4 Medium, 1-2 Low.
    """
    scale = {"Low": 1, "Medium": 2, "High": 3}
    score = scale.get(impact, 1) * scale.get(likelihood, 1)
    if score >= 9: return "Critical Risk"
    if score >= 6: return "High Risk"
    if score >= 3: return "Medium Risk"
    return "Low Risk"


def formula_risk_level(severity, impact):
    """Earlier risk formula (Severity x Impact), kept for reference only.

    The pipeline now uses formula_risk_matrix (Impact x Likelihood).
    """
    scale = {"Critical": 4, "High": 3, "Medium": 2, "Low": 1}
    score = scale.get(severity, 1) * scale.get(impact, 1)
    if score >= 12: return "Critical Risk"
    if score >= 6:  return "High Risk"
    if score >= 3:  return "Medium Risk"
    return "Low Risk"


# ============================================================================
# 7. NVD (CVE) DATA HELPERS
# ============================================================================

def pick_english_desc(desc_list):
    """Return the English description, or the first one if none is in English."""
    if not desc_list: return None
    for d in desc_list:
        if d.get("lang") == "en": return d.get("value")
    return desc_list[0].get("value")


def extract_cvss_score(cve_obj):
    """Return (base score, base severity) from the newest CVSS version present."""
    metrics = cve_obj.get("metrics", {})
    for key in ["cvssMetricV31", "cvssMetricV30", "cvssMetricV2"]:
        arr = metrics.get(key)
        if arr and len(arr) > 0:
            cvss = arr[0].get("cvssData", {})
            return cvss.get("baseScore"), cvss.get("baseSeverity")
    return None, None


def extract_cwes(cve_obj):
    """Return the CWE ids NVD assigned to a CVE (ignores NVD-CWE-Other / NVD-CWE-noinfo)."""
    found = []
    for weakness in cve_obj.get("weaknesses") or []:
        for desc in weakness.get("description") or []:
            value = str(desc.get("value", "")).strip().upper()
            if re.fullmatch(r"CWE-\d+", value) and value not in found:
                found.append(value)
    return found


def is_rejected_cve(cve_obj, description):
    """True for CVEs that NVD rejected; they describe nothing real and would pollute matches."""
    status = str(cve_obj.get("vulnStatus") or "").lower()
    return status == "rejected" or description.lstrip().upper().startswith("** REJECT")


def load_or_build_cve_embeddings(texts):
    """Embed every CVE description, reusing the on-disk cache when it is still valid.

    The cache is rebuilt when the NVD file size, the model or the CVE count changes.
    Vectors are unit length, so inner product equals cosine similarity.
    """
    # Fingerprint of the inputs; any change means the cache is stale.
    signature = {
        "model": EMBED_MODEL,
        "nvd_bytes": os.path.getsize(NVD_PATH),
        "count": len(texts),
    }
    sig_path = EMBED_CACHE + ".json"
    # Reuse the cache when the fingerprint matches.
    try:
        if os.path.exists(EMBED_CACHE) and os.path.exists(sig_path):
            with open(sig_path, "r", encoding="utf-8") as f:
                if json.load(f) == signature:
                    cached = np.load(EMBED_CACHE)
                    if cached.shape[0] == len(texts):
                        print("Loaded CVE embeddings from cache.")
                        return cached.astype("float32")
    except Exception as exc:
        print(f"CVE embedding cache ignored: {exc}")

    # Otherwise embed, normalise and save.
    vectors = embedder.encode(texts, show_progress_bar=True, batch_size=64)
    vectors = vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
    vectors = vectors.astype("float32")
    try:
        np.save(EMBED_CACHE, vectors)
        with open(sig_path, "w", encoding="utf-8") as f:
            json.dump(signature, f)
    except Exception as exc:
        print(f"Could not write CVE embedding cache: {exc}")
    return vectors


# ============================================================================
# 8. STARTUP: TRAIN CLASSIFIER AND BUILD THE CVE INDEX
# ============================================================================
# Runs once when the server starts.

# --- Security classifier: TF-IDF (1-2 word n-grams) + balanced logistic regression ---
# Trained on the labelled requirements dataset; Type 'SE' marks security requirements.
print("Loading dataset and training security classifier...")

# Load and clean the dataset.
df = pd.read_csv(DATASET_PATH)
df = df.dropna(subset=["Requirement", "Type"]).copy()
df["Requirement"] = df["Requirement"].astype(str).str.strip()
df = df[df["Requirement"].str.len() > 5]

# Binary label: 1 = security requirement (SE), 0 = anything else.
df["is_security"] = (df["Type"].str.strip().str.upper() == "SE").astype(int)
X = df["Requirement"]
y = df["is_security"]

# 80/20 stratified split so both classes appear in the test set.
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)
security_classifier = Pipeline([
    ("tfidf", TfidfVectorizer(max_features=8000, ngram_range=(1, 2))),
    ("clf",   LogisticRegression(max_iter=1000, class_weight="balanced"))
])
security_classifier.fit(X_train, y_train)

# Test-set report using the same probability threshold as production.
y_pred = (security_classifier.predict_proba(X_test)[:, 1] >= SECURITY_THRESHOLD).astype(int)
print("Security Classifier Report:")
print(classification_report(y_test, y_pred, target_names=["General", "Security"]))

# --- CVE knowledge base: load the NVD feed, embed descriptions, build FAISS index ---
print("Loading CVE data and building FAISS index...")
with open(NVD_PATH, "r", encoding="utf-8", errors="ignore") as f:
    nvd = json.load(f)

# Keep valid, non-rejected CVEs with their CVSS data, CWEs and full record.
cve_records = []
for item in nvd.get("vulnerabilities", []):
    cve_obj = item.get("cve", {})
    cve_id  = cve_obj.get("id")
    desc    = pick_english_desc(cve_obj.get("descriptions", []))
    if not (cve_id and desc) or is_rejected_cve(cve_obj, desc):
        continue
    score, sev = extract_cvss_score(cve_obj)
    cve_records.append({
        "cve_id":        cve_id,
        "description":   desc,
        "cvss_score":    score,
        "cvss_severity": sev,
        "cwes":          extract_cwes(cve_obj),
        "cve_obj":       cve_obj
    })

# One row per CVE id.
cve_df = pd.DataFrame(cve_records).drop_duplicates(subset=["cve_id"]).reset_index(drop=True)

# Embedding model and (cached) CVE vectors.
embedder       = SentenceTransformer(EMBED_MODEL)
cve_embeddings = load_or_build_cve_embeddings(cve_df["description"].tolist())

# Exact inner-product index; vectors are unit length, so this is cosine similarity.
dim   = cve_embeddings.shape[1]
index = faiss.IndexFlatIP(dim)
index.add(cve_embeddings)
print("✅ Model ready!")


# ============================================================================
# 9. CVE MATCHING AND DUPLICATE DETECTION
# ============================================================================

# Security concept keyword groups. Concepts shared by a requirement and a CVE
# description add a small re-ranking bonus.
SECURITY_CONCEPTS = {
    "password":       ["password", "credential", "authentication", "plaintext", "passphrase"],
    "encryption":     ["encrypt", "crypto", "tls", "ssl", "cipher", "decrypt", "key"],
    "injection":      ["injection", "sql", "xss", "command", "input", "query", "sanitize"],
    "access control": ["access", "privilege", "authorization", "permission", "role", "rbac"],
    "logging":        ["log", "audit", "monitor", "record", "trail"],
    "session":        ["session", "token", "cookie", "timeout", "expiry"],
    "data exposure":  ["exposure", "disclosure", "sensitive", "leak", "personal", "pii"],
    "upload":         ["upload", "file", "path", "directory", "traversal"],
    "api":            ["api", "endpoint", "request", "response", "rest"],
    "dos":            ["denial", "dos", "ddos", "availability", "flood", "rate limit"],
    "integrity":      ["integrity", "tamper", "checksum", "hash", "signature"],
    "network":        ["network", "firewall", "port", "protocol", "traffic"],
    "third party":    ["third party", "library", "dependency", "plugin", "component"],
}


def _compile_concept(keywords):
    """Compile one keyword group into a single word-boundary regex.

    Avoids false hits such as 'key' in 'keyboard'; 'log' does not match 'log in'.
    """
    parts = []
    for k in keywords:
        # "log in" is about authentication, not logging.
        if k == "log":
            parts.append(r"\blog(?!\s?(?:in|on|into|out)\b)\b")
        else:
            parts.append(r"\b" + re.escape(k) + (r"\b" if len(k) <= 4 else ""))
    return re.compile("|".join(parts), re.IGNORECASE)


# Pre-compiled concept regexes.
CONCEPT_PATTERNS = {name: _compile_concept(words) for name, words in SECURITY_CONCEPTS.items()}


def _normalize(vectors):
    """Scale vectors to unit length (safe for zero vectors)."""
    return vectors / np.maximum(np.linalg.norm(vectors, axis=-1, keepdims=True), 1e-12)


def _num(value):
    """Return a JSON-safe float, or None for missing/NaN values."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return None if value != value else value


def semantic_topk(text, k=5, vec=None):
    """Return the k CVEs closest to the text (or to a precomputed query vector)."""
    if vec is None:
        vec = _normalize(embedder.encode([text]))
    D, I = index.search(vec.astype("float32"), k)
    results = []
    for dist, idx in zip(D[0], I[0]):
        if idx < 0:
            continue
        row = cve_df.iloc[idx]
        results.append({
            "cve_id":          row["cve_id"],
            "cve_description": row["description"],
            "cvss_score":      row["cvss_score"],
            "cvss_severity":   row["cvss_severity"],
            "cwes":            row["cwes"],
            "cve_obj":         row["cve_obj"],
            "similarity":      float(dist)
        })
    return results


def exact_cve_lookup(cve_id):
    """Look up one CVE by id in the local NVD data."""
    matches = cve_df[cve_df["cve_id"].str.upper() == str(cve_id).upper()]
    if matches.empty:
        return None
    row = matches.iloc[0]
    return {
        "cve_id": row["cve_id"],
        "description": row["description"],
        "cvss_score": None if pd.isna(row["cvss_score"]) else row["cvss_score"],
        "cvss_severity": row["cvss_severity"]
    }


def build_query_vector(requirement, queries):
    """Build the CVE search vector for a requirement.

    CVE descriptions describe flaws, not "the system shall..." sentences, so when
    the weakness (or attack surface) is known its description is blended in:
    70% weakness query + 30% requirement text.
    """
    req_vec = _normalize(embedder.encode([requirement]))
    if not queries:
        return req_vec
    weak_vec = _normalize(embedder.encode([" ".join(queries)]))
    return _normalize(0.7 * weak_vec + 0.3 * req_vec)


def rank_cve_candidates(requirement, candidates, req_cwes):
    """Re-rank candidates: similarity + CWE bonus + concept bonus (up to 3 concepts)."""
    req_cwes = set(req_cwes or [])
    req_concepts = [name for name, rx in CONCEPT_PATTERNS.items() if rx.search(requirement)]
    ranked = []
    for match in candidates:
        shared = req_cwes & set(match.get("cwes") or [])
        specific = shared - GENERIC_CWES
        desc = match["cve_description"] or ""
        concepts = [name for name in req_concepts if CONCEPT_PATTERNS[name].search(desc)]
        score = match["similarity"]
        if specific:
            score += CWE_BOOST
        elif shared:
            score += GENERIC_CWE_BOOST
        score += CONCEPT_BOOST * min(len(concepts), 3)
        ranked.append({**match, "score": score, "cwe_overlap": sorted(shared),
                       "specific_cwe": bool(specific), "concept_overlap": concepts})
    ranked.sort(key=lambda item: item["score"], reverse=True)
    return ranked


def map_requirement_to_cve(requirement, posture):
    """Map a requirement to CVEs according to its posture.

      Protective control -> never mapped (a safeguard is not a vulnerability)
      Risk-indicating    -> weakness search with a CWE-assisted similarity gate
      Neutral            -> context match for the exposed attack surface,
                            e.g. login -> authentication/MFA CVEs
    """
    # Protective controls are never mapped.
    label = posture["label"]
    if label == "Protective control":
        return {"searched": False, "mapped": False, "best": None, "related": [],
                "top_similarity": None, "confidence": None, "rationale": None}

    # Risk-indicating: search for the weakness; Neutral: for the exposed attack surface.
    if label == "Risk-indicating":
        queries = [WEAKNESS_BY_KEY[k]["query"] for k in posture["weakness_keys"] if k in WEAKNESS_BY_KEY]
        expected_cwes = posture["cwes"]
    else:
        queries = posture.get("surface_queries") or []
        expected_cwes = posture.get("surface_cwes") or []
    # Search FAISS, then re-rank by CWE and concept agreement.
    vec = build_query_vector(requirement, queries)
    ranked = rank_cve_candidates(requirement, semantic_topk(requirement, k=CVE_CANDIDATES, vec=vec), expected_cwes)
    top_similarity = max((m["similarity"] for m in ranked), default=None)

    # Acceptance gate: normal similarity floor, or the lower floor when a specific CWE agrees.
    def accepted(match):
        if label == "Risk-indicating":
            return match["similarity"] >= SIM_THRESHOLD or (
                match["specific_cwe"] and match["similarity"] >= CWE_ASSISTED_THRESHOLD)
        return match["similarity"] >= CONTEXT_THRESHOLD or (
            match["specific_cwe"] and match["similarity"] >= CWE_ASSISTED_THRESHOLD)

    qualified = [m for m in ranked if accepted(m)]
    if not qualified:
        return {"searched": True, "mapped": False, "best": None, "related": [],
                "top_similarity": top_similarity, "confidence": None, "rationale": None}

    # Match confidence: High = specific CWE and similarity >= 0.55;
    # Medium = specific CWE or similarity >= 0.60; otherwise Low.
    best = qualified[0]
    if best["specific_cwe"] and best["similarity"] >= 0.55:
        confidence = "High"
    elif best["specific_cwe"] or best["similarity"] >= 0.60:
        confidence = "Medium"
    else:
        confidence = "Low"

    # Readable reasons shown in the results table.
    reasons = [f"semantic similarity {best['similarity']:.2f}"]
    if best["cwe_overlap"]:
        reasons.append("shared weakness " + ", ".join(best["cwe_overlap"]))
    if best["concept_overlap"]:
        reasons.append("shared concepts: " + ", ".join(best["concept_overlap"]))

    # Up to three runner-up CVEs.
    related = [{
        "cve_id": m["cve_id"],
        "cvss_score": _num(m["cvss_score"]),
        "similarity": round(m["similarity"], 3),
        "cwes": list(m.get("cwes") or []),
    } for m in qualified[1:4]]

    return {"searched": True, "mapped": True, "best": best, "related": related,
            "top_similarity": top_similarity, "confidence": confidence,
            "rationale": "; ".join(reasons)}


def detect_duplicates(requirements):
    """Group near-duplicate requirements (cosine similarity >= DUPLICATE_THRESHOLD).

    Returns {requirement index: group number} for requirements that have a duplicate.
    """
    if len(requirements) < 2:
        return {}

    vecs = embedder.encode(requirements)
    vecs = vecs / np.linalg.norm(vecs, axis=1, keepdims=True)

    duplicate_map = {}
    group_id = 1

    for i in range(len(requirements)):
        for j in range(i + 1, len(requirements)):
            sim = float(np.dot(vecs[i], vecs[j]))
            if sim >= DUPLICATE_THRESHOLD:
                gi = duplicate_map.get(i)
                gj = duplicate_map.get(j)
                if gi is None and gj is None:
                    duplicate_map[i] = group_id
                    duplicate_map[j] = group_id
                    group_id += 1
                elif gi is None:
                    duplicate_map[i] = gj
                elif gj is None:
                    duplicate_map[j] = gi

    return duplicate_map


# ============================================================================
# 10. FULL ANALYSIS PIPELINE (ONE REQUIREMENT)
# ============================================================================

def analyze_requirement(line):
    """Run the full pipeline on one requirement and return its result row.

      1. security classifier, requirement-likeness and quality checks
      2. security posture (risk-indicating / protective / neutral)
      3. CVE mapping (skipped for protective controls)
      4. Severity, Impact, Likelihood and Risk Level formulas
    """
    line = str(line).strip()
    if not line: return None

    # Step 1: security classifier, requirement-likeness and quality.
    security_prob = float(security_classifier.predict_proba([line])[0][1])
    is_security = security_prob >= SECURITY_THRESHOLD
    requirement_confidence, requirement_evidence = requirement_likeness(line)
    quality = assess_requirement_quality(line)

    # Step 2: security posture.
    posture = classify_security_posture(line)
    posture_label = posture["label"]
    is_protective = posture_label == "Protective control"
    is_direct_risk = posture_label == "Risk-indicating"
    security_related = is_security or posture_label != "Neutral"
    requirement_type = classify_requirement_type(line, security_related)

    # Step 3: CVE mapping (never for protective controls or non-security text).
    touches_surface = bool(posture["surface_keys"])
    if (security_related or touches_surface) and not is_protective:
        mapping = map_requirement_to_cve(line, posture)
    else:
        mapping = {"searched": False, "mapped": False, "best": None, "related": [],
                   "top_similarity": None, "confidence": None, "rationale": None}
    match = mapping["best"]

    # Step 4: formulas. Only risk-indicating wording can score above Low.
    scoring_cve_obj = match["cve_obj"] if match and is_direct_risk else None
    scoring_cvss = match["cvss_score"] if match and is_direct_risk else None
    severity = formula_severity(scoring_cvss, line, posture_label)
    impact = formula_impact(scoring_cve_obj, posture["weakness_keys"]) if is_direct_risk else "Low"
    likelihood = formula_likelihood(line, scoring_cve_obj) if is_direct_risk else "Low"
    risk_level = formula_risk_matrix(impact, likelihood)

    # Explain what the shown CVE means for this requirement.
    if is_protective:
        top_cve = "Not applicable"
        cve_interpretation = "Protective control: it reduces risk, so it is not mapped to a CVE"
    elif match and is_direct_risk:
        top_cve = match["cve_id"]
        cve_interpretation = f"Potential vulnerability evidence (match confidence: {mapping['confidence']})"
    elif match:
        top_cve = match["cve_id"]
        cve_interpretation = "Related security context only; this feature is exposed to such weaknesses, but the requirement itself is not a flaw"
    elif is_direct_risk:
        top_cve = "No strong semantic match"
        cve_interpretation = "Risk-indicating wording, but no sufficiently close CVE was found in the local NVD data"
    else:
        top_cve = "No strong semantic match"
        cve_interpretation = "No CVE mapping applicable"

    # Result row (saved to Firestore and shown in the results table).
    return {
        "Requirement":          line,
        "Requirement Type":     requirement_type,
        "Requirement Confidence": requirement_confidence,
        "Requirement Evidence": requirement_evidence,
        "Requirement Quality Score": quality["score"],
        "Quality Status":       quality["status"],
        "Quality Issues":       quality["issues"],
        "Is Security":          security_related,
        "Security Confidence":  round(security_prob, 3),
        "Security Posture":     posture_label,
        "Posture Confidence":   posture["confidence"],
        "Posture Evidence":     posture["evidence"],
        "Weakness Types":       [WEAKNESS_BY_KEY[k]["label"] for k in posture["weakness_keys"]],
        "Expected CWEs":        posture["cwes"] or posture["surface_cwes"],
        "Attack Surface":       posture["surface_labels"],
        "Predicted Severity":   severity,
        "Predicted Impact":     impact,
        "Predicted Likelihood": likelihood,
        "Risk Level":           risk_level,
        "CVE Mapped":           bool(match),
        "Top CVE":              top_cve,
        "Similarity":           round(match["similarity"], 3) if match else (
                                round(mapping["top_similarity"], 3) if mapping["top_similarity"] is not None else None),
        "CVSS Score":           _num(match["cvss_score"]) if match else None,
        "CVSS Severity":        match["cvss_severity"] if match else None,
        "CVE Description":      match["cve_description"] if match else None,
        "CVE Match Confidence": mapping["confidence"],
        "CVE Match Rationale":  mapping["rationale"],
        "Matched CWEs":         match["cwe_overlap"] if match else [],
        "Related CVEs":         mapping["related"],
        "CVE Match Interpretation": cve_interpretation
    }


# ============================================================================
# 11. FIREBASE AUTHENTICATION AND ACCESS CONTROL
# ============================================================================

def get_firestore_client():
    """Initialise Firebase Admin once and return a Firestore client.

    Uses FIREBASE_SERVICE_ACCOUNT_PATH from .env, otherwise Application Default
    Credentials. The service-account key never leaves the backend.
    """
    if not firebase_admin._apps:
        service_account_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "").strip()
        service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
        try:
            if service_account_json:
                # Hosted deployment: the whole service-account JSON is stored as a secret.
                firebase_admin.initialize_app(credentials.Certificate(json.loads(service_account_json)))
            elif service_account_path:
                firebase_admin.initialize_app(credentials.Certificate(service_account_path))
            else:
                firebase_admin.initialize_app(credentials.ApplicationDefault())
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail="Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON (hosted) or FIREBASE_SERVICE_ACCOUNT_PATH (local)."
            ) from exc
    return firestore.client()


def verify_firebase_user(authorization):
    """Verify the 'Bearer <Firebase ID token>' header and return (uid, email)."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="A Firebase ID token is required.")
    token = authorization.split(" ", 1)[1].strip()
    try:
        decoded = firebase_auth.verify_id_token(token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired Firebase ID token.") from exc
    email = str(decoded.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=403, detail="The authenticated account has no email address.")
    return decoded.get("uid"), email


def project_access_role(project, email):
    """Return 'leader', 'team_member' or None for this email on this project."""
    leader_email = str(project.get("leaderEmail") or "").lower()
    member_emails = [str(value).lower() for value in (project.get("memberEmails") or [])]
    member_emails.extend(
        str(member.get("email") or "").lower()
        for member in (project.get("members") or [])
        if isinstance(member, dict)
    )
    if email == leader_email:
        return "leader"
    if email in member_emails:
        return "team_member"
    return None


def require_active_user(db, email, allowed_roles=None):
    """Return the user's role from the 'users' collection, or raise 403.

    Rejects accounts that are missing, disabled by the admin, or (when
    allowed_roles is given) whose role may not use this endpoint.
    """
    matches = list(db.collection("users").where("email", "==", email).limit(1).stream())
    profile = (matches[0].to_dict() or {}) if matches else None
    if not profile or profile.get("isActive") is False:
        raise HTTPException(status_code=403, detail="This account is not registered or has been disabled.")
    role = profile.get("role")
    if allowed_roles and role not in allowed_roles:
        raise HTTPException(status_code=403, detail="Your role is not allowed to perform this action.")
    return role


# ============================================================================
# 12. API ENDPOINTS: ANALYSIS
# ============================================================================

@app.post("/analyze")
async def analyze(
    file: UploadFile | None = File(default=None),
    text: str | None = Form(default=None),
    project_id: str | None = Form(default=None),
    authorization: str | None = Header(default=None),
):
    """POST /analyze - analyse an uploaded PDF/TXT, pasted text, or both.

    Only an active team leader may call it, and only for a project they lead.
    Validates the input, rejects non-SRS documents, extracts and filters the
    requirements, flags duplicates and returns one result row per requirement.
    """
    # 0) Authentication and role: valid Firebase token, active leader, leader of this project.
    db = get_firestore_client()
    uid, email = verify_firebase_user(authorization)
    require_active_user(db, email, allowed_roles=["leader"])
    if not (project_id or "").strip():
        raise HTTPException(status_code=400, detail="A project must be selected before running the analysis.")
    project_snapshot = db.collection("projects").document(project_id.strip()).get()
    if not project_snapshot.exists:
        raise HTTPException(status_code=404, detail="Project not found.")
    if project_access_role(project_snapshot.to_dict() or {}, email) != "leader":
        raise HTTPException(status_code=403, detail="Only the project leader can run the analysis.")

    extracted_parts = []

    # 1) Read and check the uploaded file: type, emptiness, size, encryption, pages, encoding.
    if file is not None and (file.filename or "").strip():
        content = await file.read()
        filename = file.filename or ""
        extension = os.path.splitext(filename)[1].lower()
        if extension not in ALLOWED_EXTENSIONS:
            return JSONResponse(status_code=415, content={
                "error": "Unsupported file type. Please upload an English requirements document in PDF or TXT format."
            })
        if not content:
            return JSONResponse(status_code=400, content={
                "error": "The uploaded file is empty. Please upload a file with content."
            })
        if len(content) > MAX_UPLOAD_BYTES:
            return JSONResponse(status_code=413, content={
                "error": "The file is too large. The maximum supported size is 5 MB."
            })

        if extension == ".pdf":
            try:
                reader = PdfReader(io.BytesIO(content))
                if reader.is_encrypted:
                    return JSONResponse(status_code=400, content={
                        "error": "Password-protected PDFs are not supported. Please upload an unlocked PDF."
                    })
                if len(reader.pages) > MAX_PDF_PAGES:
                    return JSONResponse(status_code=413, content={
                        "error": "The PDF has too many pages. The maximum supported length is 100 pages."
                    })
                extracted_parts.append("\n".join(p.extract_text() or "" for p in reader.pages))
            except Exception:
                return JSONResponse(status_code=400, content={
                    "error": "Could not read the PDF file. Please make sure it is a valid, non-corrupted PDF."
                })
        else:
            try:
                decoded = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                return JSONResponse(status_code=400, content={
                    "error": "Could not read the TXT file. Please upload a valid UTF-8 plain-text document."
                })
            if "\x00" in decoded:
                return JSONResponse(status_code=400, content={
                    "error": "The TXT file contains binary data. Please upload a valid plain-text requirements document."
                })
            extracted_parts.append(decoded)

    # 2) Add pasted text.
    pasted_text = (text or "").strip()
    if pasted_text:
        if len(pasted_text.encode("utf-8")) > MAX_UPLOAD_BYTES:
            return JSONResponse(status_code=413, content={
                "error": "The pasted text is too large. The maximum supported size is 5 MB."
            })
        extracted_parts.append(pasted_text)

    if not extracted_parts:
        return JSONResponse(status_code=400, content={
            "error": "Please upload a PDF/TXT file or paste English software requirements."
        })

    # 3) Combine the inputs.
    text = "\n".join(part for part in extracted_parts if part.strip())

    if not text.strip():
        return JSONResponse(status_code=400, content={
            "error": "The uploaded file is empty. Please upload a file with content."
        })

    # 4) Reject CVs, resumes and coursework instructions before any analysis.
    unrelated_type, unrelated_markers = detect_unrelated_document(text)
    if unrelated_type:
        marker_text = ", ".join(unrelated_markers) if unrelated_markers else "document structure"
        return JSONResponse(status_code=400, content={
            "error": (
                f"The uploaded file appears to be a {unrelated_type}, not a software requirements document. "
                f"Detected indicators: {marker_text}. Please upload an SRS or explicit system requirements."
            )
        })

    # 5) Extract and filter requirement lines.
    raw_lines = extract_requirements(text)
    is_valid, error_msg, valid_lines = validate_document(raw_lines)

    if not is_valid:
        return JSONResponse(status_code=400, content={"error": error_msg})
    if len(valid_lines) > MAX_REQUIREMENTS:
        return JSONResponse(status_code=413, content={
            "error": f"Too many requirements were found. The maximum supported number is {MAX_REQUIREMENTS}."
        })

    # 6) Mark near-duplicates.
    duplicate_map = detect_duplicates(valid_lines)

    # 7) Analyse each requirement; NaN values become None so the JSON is valid.
    results = []
    for i, ln in enumerate(valid_lines):
        out = analyze_requirement(ln)
        if out:
            cleaned = {
                k: (None if (v is None or (isinstance(v, float) and v != v)) else v)
                for k, v in out.items()
            }
            cleaned["Is Duplicate"]    = i in duplicate_map
            cleaned["Duplicate Group"] = duplicate_map.get(i, None)
            results.append(cleaned)

    if not results:
        return JSONResponse(status_code=400, content={
            "error": "No requirements could be analyzed. Please check your document."
        })

    return results


# Request body for /reanalyze-requirement.
class ReanalyzeRequest(BaseModel):
    project_id: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=3000)


@app.post("/reanalyze-requirement")
async def reanalyze_requirement(request: ReanalyzeRequest, authorization: str | None = Header(default=None)):
    """POST /reanalyze-requirement - re-check one revised requirement (leader only).

    Runs the same pipeline on the team's approved fix so the leader can see
    whether it still carries, or newly introduces, a real security risk without
    re-analysing the whole document.
    """
    db = get_firestore_client()
    uid, email = verify_firebase_user(authorization)
    require_active_user(db, email, allowed_roles=["leader"])

    # Only the project leader may run this check.
    project_snapshot = db.collection("projects").document(request.project_id).get()
    if not project_snapshot.exists:
        raise HTTPException(status_code=404, detail="Project not found.")
    project = project_snapshot.to_dict() or {}
    role = project_access_role(project, email)
    if role != "leader":
        raise HTTPException(status_code=403, detail="Only the project leader can run a new-risk check.")

    # Same pipeline as full analysis, on the revised text.
    result = analyze_requirement(request.text)
    if not result:
        raise HTTPException(status_code=400, detail="Could not analyze the provided text.")

    # Flag only if the revised wording still maps to a real CVE at Critical/High severity.
    top_cve = result.get("Top CVE")
    has_match = bool(top_cve) and top_cve not in ("No strong semantic match", "Not applicable")
    flagged = has_match and result.get("Predicted Severity") in ("Critical", "High")

    return {
        "newSeverity":        result.get("Predicted Severity"),
        "newRiskLevel":       result.get("Risk Level"),
        "newTopCve":          top_cve,
        "newSimilarity":      result.get("Similarity"),
        "newCveDescription":  result.get("CVE Description"),
        "newSecurityPosture": result.get("Security Posture"),
        "newInterpretation":  result.get("CVE Match Interpretation"),
        "flagged":            flagged
    }


@app.get("/health")
def health():
    """GET /health - liveness check."""
    return {"status": "ok"}


# ============================================================================
# 13. AI ASSISTANT (CHATBOT)
# ============================================================================
# Hybrid assistant: Firestore is the source of truth for access, results, tasks
# and chat history; the local NVD data supplies CVE facts; OpenAI writes the
# answer. Without OpenAI a limited rule-based answer is returned.

# Request body for /chat.
class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    project_id: str = Field(min_length=1, max_length=200)
    session_id: str = Field(min_length=1, max_length=200)


def load_project_results(db, project_id):
    """Return the most recent saved analysis results for a project."""
    direct = db.collection("project_results").document(project_id).get()
    documents = [direct] if direct.exists else list(
        db.collection("project_results").where("projectId", "==", project_id).stream()
    )
    valid = [document.to_dict() or {} for document in documents if document.exists]
    if not valid:
        return []
    valid.sort(key=lambda item: str(item.get("analyzedAt") or ""), reverse=True)
    return valid[0].get("results") or []


def load_authorized_tasks(db, project_id, email, role):
    """Return the tasks this user may see: all for the leader, own tasks for a member."""
    documents = db.collection("tasks").where("projectId", "==", project_id).stream()
    tasks = []
    for document in documents:
        task = {"id": document.id, **(document.to_dict() or {})}
        if role == "leader":
            tasks.append(task)
            continue
        assigned_emails = [str(value).lower() for value in (task.get("assignedEmails") or [])]
        assigned_to = task.get("assignedTo") or {}
        if isinstance(assigned_to, dict):
            assigned_emails.append(str(assigned_to.get("email") or "").lower())
        if email in assigned_emails:
            tasks.append(task)
    return tasks


def load_private_history(db, session_id, uid, project_id):
    """Return the last 12 messages of the user's own chat session (ownership is checked)."""
    session_ref = db.collection("chatbotSessions").document(session_id)
    session = session_ref.get()
    if not session.exists:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    session_data = session.to_dict() or {}
    if session_data.get("userId") != uid or session_data.get("projectId") != project_id:
        raise HTTPException(status_code=403, detail="You cannot access this conversation.")
    messages = session_ref.collection("messages").order_by("createdAt").limit_to_last(12).get()
    return [
        {"role": item.get("role"), "content": item.get("content")}
        for snapshot in messages
        for item in [snapshot.to_dict() or {}]
        if item.get("role") in ["user", "assistant"] and item.get("content")
    ]


def select_relevant_results(question, results, maximum=10):
    """Return the (up to 10) results most similar to the question."""
    if len(results) <= maximum:
        return results
    texts = [
        " ".join(str(item.get(key) or "") for key in ["Requirement", "Top CVE", "CVE Description", "Risk Level"])
        for item in results
    ]
    vectors = embedder.encode([question] + texts)
    vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    scores = np.dot(vectors[1:], vectors[0])
    indices = np.argsort(scores)[::-1][:maximum]
    return [results[int(index)] for index in indices]


def build_local_cve_context(question):
    """Collect CVE facts: CVE ids named in the question, otherwise the 3 closest CVEs."""
    cve_ids = list(dict.fromkeys(re.findall(r"\bCVE-\d{4}-\d{4,}\b", question, flags=re.I)))
    context = []
    for cve_id in cve_ids[:3]:
        match = exact_cve_lookup(cve_id)
        if match:
            context.append(match)
    if not context:
        for match in semantic_topk(question, k=3):
            context.append({
                "cve_id": match["cve_id"],
                "description": match["cve_description"],
                "cvss_score": match["cvss_score"],
                "cvss_severity": match["cvss_severity"],
                "similarity": round(match["similarity"], 3)
            })
    return cve_ids, context


def mitigation_for(text):
    """Return a generic mitigation tip chosen by keyword (used by the offline answer)."""
    value = str(text or "").lower()
    if any(word in value for word in ["sql injection", "injection", "query"]):
        return "Use parameterized queries, validate input on the server, and apply least-privilege database permissions."
    if any(word in value for word in ["password", "credential", "authentication", "login"]):
        return "Use strong authentication, securely hash passwords, add rate limiting, and consider multi-factor authentication."
    if any(word in value for word in ["xss", "cross-site", "script"]):
        return "Apply context-aware output encoding, validate input, and use a restrictive Content Security Policy."
    if any(word in value for word in ["access", "authorization", "privilege", "permission"]):
        return "Enforce server-side authorization for every protected action and follow least privilege."
    if any(word in value for word in ["encrypt", "plaintext", "sensitive", "exposure"]):
        return "Encrypt sensitive data in transit and at rest, protect keys separately, and minimize stored sensitive data."
    if any(word in value for word in ["upload", "file", "path", "directory"]):
        return "Allow-list file types, verify content and size, rename uploads, and store them outside executable paths."
    if any(word in value for word in ["dos", "denial", "rate limit", "availability"]):
        return "Add rate limiting, request-size limits, timeouts, monitoring, and capacity controls."
    return "Review the affected requirement, apply least privilege and secure defaults, then validate the control through security testing."


def project_summary(project_name, results):
    """One-line summary of a project's risk distribution."""
    if not results:
        return f"{project_name} does not have saved analysis results yet. Run an analysis before asking about its risks."
    counts = {}
    for item in results:
        level = str(item.get("Risk Level") or item.get("Predicted Severity") or "Unknown")
        counts[level] = counts.get(level, 0) + 1
    summary = ", ".join(f"{name}: {count}" for name, count in sorted(counts.items()))
    return f"{project_name} contains {len(results)} analyzed requirement results. Risk distribution: {summary}."


def task_summary(tasks, role):
    """One-line summary of task statuses (all tasks for leaders, own tasks for members)."""
    if not tasks:
        if role == "leader":
            return "This project does not have any tasks yet."
        return "You do not have any tasks assigned to you in this project."

    counts = {}
    for task in tasks:
        status = str(task.get("status") or "Unknown")
        counts[status] = counts.get(status, 0) + 1

    distribution = ", ".join(
        f"{status}: {count}"
        for status, count in sorted(counts.items())
    )

    if role == "leader":
        return (
            f"This project has {len(tasks)} task(s). "
            f"Status summary: {distribution}."
        )

    return (
        f"You have {len(tasks)} assigned task(s). "
        f"Status summary: {distribution}."
    )


def local_fallback_answer(question, project_name, role, results, tasks):
    """Rule-based answer used when OpenAI is not configured or fails."""
    lower = question.lower()
    if any(term in lower for term in ["task", "deadline", "due date", "assigned"]):
        return task_summary(tasks, role)
    if any(term in lower for term in ["highest", "critical", "top risk"]):
        if not results:
            return f"{project_name} does not have saved analysis results yet."
        scale = {"critical": 4, "critical risk": 4, "high": 3, "high risk": 3, "medium": 2, "medium risk": 2, "low": 1, "low risk": 1}
        highest = max(results, key=lambda item: scale.get(str(item.get("Risk Level") or item.get("Predicted Severity") or "").lower(), 0))
        requirement = highest.get("Requirement") or "Unknown requirement"
        return (
            f"Highest saved risk: {highest.get('Risk Level') or highest.get('Predicted Severity') or 'Unknown'}.\n\n"
            f"Requirement: {requirement}\nRelated CVE: {highest.get('Top CVE') or 'No strong semantic match'}\n\n"
            f"Mitigation: {mitigation_for(requirement + ' ' + str(highest.get('CVE Description') or ''))}"
        )
    return project_summary(project_name, results) + " " + task_summary(tasks, role)


def generate_hybrid_answer(question, project_name, role, results, tasks, history, cve_context):
    """Ask OpenAI for an answer grounded only in authorised project data and local CVEs.

    Returns None when no API key is configured.
    """
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None
    client = OpenAI(api_key=api_key)
    model = os.getenv("OPENAI_MODEL", "gpt-6-astra").strip() or "gpt-6-astra"
    safe_results = select_relevant_results(question, results)
    context = {
        "project": project_name,
        "viewer_role": role,
        "risk_results": safe_results,
        "authorized_tasks": tasks[:30],
        "local_cve_references": cve_context,
        "recent_private_conversation": history[-10:]
    }
    # System instructions: grounded, English only, never invent facts.
    instructions = """You are the METRAS cybersecurity assistant. Answer in English only.
Use only the supplied authorized project context and local CVE references for project-specific facts.
The viewer is already authorized: a leader receives every task in the project; a member receives only their own assigned tasks. Never imply access to hidden tasks or other projects.
Answer any relevant question about the selected project's requirements, risk results, CVEs, CVSS, assigned tasks, deadlines, statuses, and security improvements.
When asked for mitigation, provide practical requirement-level recommendations and clearly label them as guidance requiring human validation.
Never claim that semantic CVE similarity proves a vulnerability exists. Do not invent requirements, tasks, dates, CVE details, scores, or completion status.
If the context does not contain the requested fact, say that it is unavailable. Keep answers clear and concise for both technical and non-technical users."""
    response = client.responses.create(
        model=model,
        instructions=instructions,
        input=f"Authorized METRAS context:\n{json.dumps(context, ensure_ascii=True, default=str)}\n\nUser question:\n{question}",
        max_output_tokens=700
    )
    return response.output_text.strip()


@app.post("/chat")
async def chat(request: ChatRequest, authorization: str | None = Header(default=None)):
    """POST /chat - project assistant grounded in Firestore data and the local NVD feed.

    Checks access, gathers results, tasks, history and CVE context, asks OpenAI,
    and falls back to a local answer if OpenAI is unavailable.
    """
    db = get_firestore_client()
    uid, email = verify_firebase_user(authorization)
    require_active_user(db, email, allowed_roles=["leader", "team_member"])
    project_snapshot = db.collection("projects").document(request.project_id).get()
    if not project_snapshot.exists:
        raise HTTPException(status_code=404, detail="Project not found.")
    project = project_snapshot.to_dict() or {}
    role = project_access_role(project, email)
    if not role:
        raise HTTPException(status_code=403, detail="You do not have access to this project.")

    results = load_project_results(db, request.project_id)
    tasks = load_authorized_tasks(db, request.project_id, email, role)
    history = load_private_history(db, request.session_id, uid, request.project_id)
    cve_ids, cve_context = build_local_cve_context(request.message)
    project_name = project.get("name") or "Selected project"

    # Try OpenAI; on any error fall back to the local answer.
    try:
        answer = generate_hybrid_answer(
            request.message, project_name, role, results, tasks, history, cve_context
        )
    except Exception as exc:
        print(f"OpenAI response failed: {exc}")
        answer = None

    source_type = "openai_grounded_firebase_nvd"
    if not answer:
        answer = local_fallback_answer(request.message, project_name, role, results, tasks)
        answer += "\n\nThe AI service is not configured or temporarily unavailable, so this is a limited local response."
        source_type = "local_fallback"

    return {
        "answer": answer,
        "detectedCveIds": [item.upper() for item in cve_ids],
        "sourceType": source_type,
        "viewerRole": role,
        "disclaimer": "METRAS provides decision support. CVE matches and mitigation guidance require human validation."
    }
