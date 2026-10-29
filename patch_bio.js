const fs = require('fs');
const path = 'E:/androidprojects/presence/server/src/modules/biometrics/routes.ts';
let s = fs.readFileSync(path, 'utf8');
const idx = s.lastIndexOf('for (const path');
if (idx >= 0) {
  const end = s.indexOf('};', idx);
  if (end >= 0) {
    const replacement = `  ];

  // Enrollment/Re-enrollment/Delete/Status/Verify (merged from face module)
  app.get(
    '/api/v1/biometrics/status',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Read the face-enrolment status of the authenticated employee',
        tags: ['Biometrics'],
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const result = await getFaceStatus(fastify, request.user.userId, request.user.organizationId);
      return reply.send(result);
    }
  );

  app.get(
    '/api/v1/biometrics/staff/:staffProfileId/status',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Read the face-enrolment status of a staff member',
        tags: ['Biometrics'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params;
      const result = await getStaffFaceStatus(fastify, request.user.organizationId, staffProfileId);
      return reply.send(result);
    }
  );

  app.get(
    '/api/v1/face/status',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Read the face-enrolment status of the authenticated employee',
        tags: ['Biometrics'],
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const result = await getFaceStatus(fastify, request.user.userId, request.user.organizationId);
      return reply.send(result);
    }
  );

  app.get(
    '/api/v1/face/staff/:staffProfileId/status',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Read the face-enrolment status of a staff member',
        tags: ['Biometrics'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params;
      const result = await getStaffFaceStatus(fastify, request.user.organizationId, staffProfileId);
      return reply.send(result);
    }
  );

  app.post(
    '/api/v1/biometrics/enroll',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Supervised face enrolment/re-enrolment',
        tags: ['Biometrics'],
        body: supervisedEnrollFaceSchema,
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const result = await enrollFaceSupervised(fastify, request.user.userId, request.user.organizationId, request.body);
      return reply.send(result);
    }
  );

  app.post(
    '/api/v1/biometrics/re-enroll',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Supervised face re-enrolment',
        tags: ['Biometrics'],
        body: supervisedEnrollFaceSchema,
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const result = await enrollFaceSupervised(fastify, request.user.userId, request.user.organizationId, request.body);
      return reply.send(result);
    }
  );

  app.post(
    '/api/v1/face/enroll/supervised',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Supervised face enrolment/re-enrolment',
        tags: ['Biometrics'],
        body: supervisedEnrollFaceSchema,
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const result = await enrollFaceSupervised(fastify, request.user.userId, request.user.organizationId, request.body);
      return reply.send(result);
    }
  );

  app.delete(
    '/api/v1/biometrics/enrollment/:staffProfileId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Delete/revoke face enrollment',
        tags: ['Biometrics'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        response: { 200: z.object({ revoked: z.boolean(), staffProfileId: z.string().uuid() }) },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params;
      const result = await revokeFaceEnrollment(fastify, request.user.userId, request.user.organizationId, staffProfileId);
      return reply.send(result);
    }
  );

  app.delete(
    '/api/v1/face/enrollment/:staffProfileId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Delete/revoke face enrollment',
        tags: ['Biometrics'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        response: { 200: z.object({ revoked: z.boolean(), staffProfileId: z.string().uuid() }) },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params;
      const result = await revokeFaceEnrollment(fastify, request.user.userId, request.user.organizationId, staffProfileId);
      return reply.send(result);
    }
  );

  app.post(
    '/api/v1/biometrics/verify',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Compare a candidate embedding against the enrolled template',
        tags: ['Biometrics'],
        body: verifyFaceSchema,
        response: { 200: faceVerificationSchema },
      },
    },
    async (request, reply) => {
      const result = await verifyFace(fastify, request.user.userId, request.user.organizationId, request.body.embeddingVector);
      return reply.send(result);
    }
  );

  app.post(
    '/api/v1/face/verify',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Compare a candidate embedding against the enrolled template',
        tags: ['Biometrics'],
        body: verifyFaceSchema,
        response: { 200: faceVerificationSchema },
      },
    },
    async (request, reply) => {
      const result = await verifyFace(fastify, request.user.userId, request.user.organizationId, request.body.embeddingVector);
      return reply.send(result);
    }
  );
};`;
    s = s.slice(0, idx) + replacement;
    fs.writeFileSync(path, s);
    console.log('done');
  }
}
EOF
node E:\androidprojects\presence\server\patch_bio.js 2>&1 | tail -2