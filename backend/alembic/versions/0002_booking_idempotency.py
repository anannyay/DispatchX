"""durable customer-scoped booking retry identities

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-20
"""
from alembic import op
import sqlalchemy as sa


revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "booking_identities",
        sa.Column("order_id", sa.Integer(), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"]),
        sa.ForeignKeyConstraint(["customer_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("order_id"),
        sa.UniqueConstraint("customer_id", "key_hash", name="uq_booking_customer_key"),
    )


def downgrade() -> None:
    op.drop_table("booking_identities")
