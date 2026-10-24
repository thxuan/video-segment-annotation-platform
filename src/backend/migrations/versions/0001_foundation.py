"""Create tenants, users, sessions and tasks for the foundation step."""
from alembic import op
import sqlalchemy as sa

revision = "0001_foundation"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "tenants",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_tenants"),
        sa.UniqueConstraint("name", name="uq_tenants_name"),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(100), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.CheckConstraint("role IN ('admin', 'annotator')", name=op.f("ck_users_valid_role")),
        sa.CheckConstraint(
            "(role = 'admin' AND tenant_id IS NULL) OR (role = 'annotator' AND tenant_id IS NOT NULL)",
            name=op.f("ck_users_role_tenant"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
        sa.UniqueConstraint("username", name="uq_users_username"),
        sa.UniqueConstraint("id", "tenant_id", name="uq_users_id_tenant"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], name="fk_users_tenant_id_tenants"),
    )
    op.create_index("ix_users_tenant_id", "users", ["tenant_id"])
    op.create_table(
        "login_sessions",
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("csrf_token", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("token_hash", name="pk_login_sessions"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_login_sessions_user_id_users", ondelete="CASCADE"),
    )
    op.create_index("ix_login_sessions_user_id", "login_sessions", ["user_id"])
    op.create_index("ix_login_sessions_expires_at", "login_sessions", ["expires_at"])
    op.create_table(
        "tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("video_key", sa.String(255), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("assignee_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("duration_ms > 0", name=op.f("ck_tasks_positive_duration")),
        sa.CheckConstraint(
            "(status = 'available' AND assignee_id IS NULL AND submitted_at IS NULL) OR "
            "(status = 'in_progress' AND assignee_id IS NOT NULL AND submitted_at IS NULL) OR "
            "(status = 'submitted' AND assignee_id IS NOT NULL AND submitted_at IS NOT NULL)",
            name=op.f("ck_tasks_state_consistency"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_tasks"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], name="fk_tasks_tenant_id_tenants"),
        sa.ForeignKeyConstraint(["assignee_id", "tenant_id"], ["users.id", "users.tenant_id"], name="fk_tasks_assignee_tenant"),
    )
    op.create_index("ix_tasks_tenant_status", "tasks", ["tenant_id", "status"])


def downgrade():
    op.drop_table("tasks")
    op.drop_table("login_sessions")
    op.drop_table("users")
    op.drop_table("tenants")
