#!/bin/bash
# Create Linear Tickets for Akash Deployment Epic
# Uses Linear GraphQL API

set -e

LINEAR_API="https://api.linear.app/graphql"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}🎫 Creating Linear Tickets for Akash Deployment${NC}"
echo "================================================"
echo ""

# Check API key
if [ -z "$LINEAR_API_KEY" ]; then
    echo "❌ LINEAR_API_KEY not set in environment"
    exit 1
fi

# Function to make GraphQL request
graphql_query() {
    local query="$1"
    curl -s -X POST "$LINEAR_API" \
        -H "Authorization: $LINEAR_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"query\": $(echo "$query" | jq -Rs .)}"
}

# Get team ID for "ALT"
echo "1. Getting team ID..."
TEAM_QUERY='query { teams { nodes { id key name } } }'
TEAM_RESPONSE=$(graphql_query "$TEAM_QUERY")
TEAM_ID=$(echo "$TEAM_RESPONSE" | jq -r '.data.teams.nodes[] | select(.key == "ALT") | .id')

if [ -z "$TEAM_ID" ]; then
    echo "❌ Could not find team 'ALT'"
    exit 1
fi
echo -e "${GREEN}✅ Found team ALT: $TEAM_ID${NC}"

# Get or create project "Decentralized Cloud Launch"
echo ""
echo "2. Getting project..."
PROJECT_QUERY='query { projects { nodes { id name } } }'
PROJECT_RESPONSE=$(graphql_query "$PROJECT_QUERY")
PROJECT_ID=$(echo "$PROJECT_RESPONSE" | jq -r '.data.projects.nodes[] | select(.name == "Decentralized Cloud Launch") | .id')

if [ -z "$PROJECT_ID" ]; then
    echo "⚠️  Project 'Decentralized Cloud Launch' not found"
    echo "Creating project..."

    CREATE_PROJECT='mutation {
        projectCreate(input: {
            name: "Decentralized Cloud Launch"
            teamIds: ["'"$TEAM_ID"'"]
        }) {
            project { id name }
        }
    }'

    CREATE_RESPONSE=$(graphql_query "$CREATE_PROJECT")
    PROJECT_ID=$(echo "$CREATE_RESPONSE" | jq -r '.data.projectCreate.project.id')
    echo -e "${GREEN}✅ Created project: $PROJECT_ID${NC}"
else
    echo -e "${GREEN}✅ Found project: $PROJECT_ID${NC}"
fi

# Function to create issue
create_issue() {
    local title="$1"
    local description="$2"
    local priority="$3"
    local parent_id="$4"

    # Escape description for JSON
    local escaped_desc=$(echo "$description" | jq -Rs .)

    local mutation="mutation {
        issueCreate(input: {
            title: \"$title\"
            description: $escaped_desc
            teamId: \"$TEAM_ID\"
            projectId: \"$PROJECT_ID\"
            priority: $priority
            ${parent_id:+parentId: \"$parent_id\"}
        }) {
            issue { id identifier title }
        }
    }"

    local response=$(graphql_query "$mutation")
    echo "$response" | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'
    echo "$response" | jq -r '.data.issueCreate.issue.id'
}

# Read ticket files
TICKETS_DIR="/Users/wonderwomancode/Projects/alternatefutures/service-cloud-api/.linear/tickets"

echo ""
echo "3. Creating Epic..."
EPIC_DESC=$(cat "$TICKETS_DIR/EPIC-testnet-to-mainnet.md")
EPIC_RESULT=$(create_issue \
    "EPIC: Deploy Backend Infrastructure to Akash (Testnet → Mainnet)" \
    "$EPIC_DESC" \
    "1" \
    "")
EPIC_ID=$(echo "$EPIC_RESULT" | tail -1)
EPIC_IDENTIFIER=$(echo "$EPIC_RESULT" | head -1)
echo -e "${GREEN}✅ Created $EPIC_IDENTIFIER${NC}"

echo ""
echo "4. Creating Phase tickets..."

# Phase 1
PHASE1_DESC=$(cat "$TICKETS_DIR/PHASE1-testnet-deployment.md")
PHASE1_RESULT=$(create_issue \
    "Phase 1: Testnet Deployment Setup" \
    "$PHASE1_DESC" \
    "1" \
    "$EPIC_ID")
echo -e "${GREEN}✅ Created $(echo "$PHASE1_RESULT" | head -1)${NC}"

# Phase 2
PHASE2_DESC=$(cat "$TICKETS_DIR/PHASE2-service-verification.md")
PHASE2_RESULT=$(create_issue \
    "Phase 2: Service Verification & Initial Testing" \
    "$PHASE2_DESC" \
    "1" \
    "$EPIC_ID")
echo -e "${GREEN}✅ Created $(echo "$PHASE2_RESULT" | head -1)${NC}"

# Phase 3
PHASE3_DESC=$(cat "$TICKETS_DIR/PHASE3-performance-testing.md")
PHASE3_RESULT=$(create_issue \
    "Phase 3: Performance Testing & Benchmarking" \
    "$PHASE3_DESC" \
    "1" \
    "$EPIC_ID")
echo -e "${GREEN}✅ Created $(echo "$PHASE3_RESULT" | head -1)${NC}"

# Phase 4
PHASE4_DESC=$(cat "$TICKETS_DIR/PHASE4-ha-testing.md")
PHASE4_RESULT=$(create_issue \
    "Phase 4: High Availability Testing" \
    "$PHASE4_DESC" \
    "0" \
    "$EPIC_ID")
echo -e "${GREEN}✅ Created $(echo "$PHASE4_RESULT" | head -1)${NC}"

# Phase 5
PHASE5_DESC=$(cat "$TICKETS_DIR/PHASE5-stability-testing.md")
PHASE5_RESULT=$(create_issue \
    "Phase 5: 72-Hour Stability Testing" \
    "$PHASE5_DESC" \
    "0" \
    "$EPIC_ID")
echo -e "${GREEN}✅ Created $(echo "$PHASE5_RESULT" | head -1)${NC}"

# Phase 6
PHASE6_DESC=$(cat "$TICKETS_DIR/PHASE6-migration-decision.md")
PHASE6_RESULT=$(create_issue \
    "Phase 6: Migration Decision & Mainnet Preparation" \
    "$PHASE6_DESC" \
    "0" \
    "$EPIC_ID")
echo -e "${GREEN}✅ Created $(echo "$PHASE6_RESULT" | head -1)${NC}"

# Phase 7
PHASE7_DESC=$(cat "$TICKETS_DIR/PHASE7-mainnet-deployment.md")
PHASE7_RESULT=$(create_issue \
    "Phase 7: Mainnet Deployment" \
    "$PHASE7_DESC" \
    "0" \
    "$EPIC_ID")
echo -e "${GREEN}✅ Created $(echo "$PHASE7_RESULT" | head -1)${NC}"

# Phase 8
PHASE8_DESC=$(cat "$TICKETS_DIR/PHASE8-post-mainnet-monitoring.md")
PHASE8_RESULT=$(create_issue \
    "Phase 8: Post-Mainnet Monitoring & Validation" \
    "$PHASE8_DESC" \
    "1" \
    "$EPIC_ID")
echo -e "${GREEN}✅ Created $(echo "$PHASE8_RESULT" | head -1)${NC}"

echo ""
echo "================================================"
echo -e "${GREEN}✅ All tickets created successfully!${NC}"
echo ""
echo "View in Linear:"
echo "  https://linear.app/alternatefutures/project/decentralized-cloud-launch"
echo ""
echo "Epic: $EPIC_IDENTIFIER"
echo "  - 8 phase tickets created as children"
echo ""
