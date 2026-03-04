import { LinkedInEmailParserService } from './linkedin-email-parser.service';

describe('LinkedInEmailParserService', () => {
  let service: LinkedInEmailParserService;

  beforeEach(() => {
    service = new LinkedInEmailParserService();
  });

  describe('isLinkedIn detection', () => {
    it('detects LinkedIn sender by domain', () => {
      const result = service.parse(
        'Some subject',
        '',
        'notifications@linkedin.com',
      );
      expect(result.isLinkedIn).toBe(true);
    });

    it('detects LinkedIn via e.linkedin.com subdomain', () => {
      const result = service.parse(
        'Sarah Chen reacted to your post',
        '',
        'noreply@e.linkedin.com',
      );
      expect(result.isLinkedIn).toBe(true);
    });

    it('returns isLinkedIn false for non-LinkedIn email', () => {
      const result = service.parse(
        'Hello there',
        'Some body',
        'user@gmail.com',
      );
      expect(result.isLinkedIn).toBe(false);
    });
  });

  describe('reaction parsing', () => {
    it('parses reaction notification', () => {
      const result = service.parse(
        'Sarah Chen reacted to your post',
        '',
        'noreply@linkedin.com',
      );
      expect(result.isLinkedIn).toBe(true);
      expect(result.type).toBe('reaction');
      expect(result.engagerName).toBe('Sarah Chen');
      expect(result.action).toBe('reacted to your post');
    });
  });

  describe('comment parsing', () => {
    it('parses comment notification', () => {
      const result = service.parse(
        'Mike Torres commented on your post',
        '',
        'noreply@linkedin.com',
      );
      expect(result.isLinkedIn).toBe(true);
      expect(result.type).toBe('comment');
      expect(result.engagerName).toBe('Mike Torres');
    });

    it('extracts comment preview from body if available', () => {
      const result = service.parse(
        'Mike Torres commented on your post',
        'Mike Torres commented: "This is a great insight about AI agents!"',
        'noreply@linkedin.com',
      );
      expect(result.commentPreview).toBe(
        'This is a great insight about AI agents!',
      );
    });
  });

  describe('follow parsing', () => {
    it('parses follow notification', () => {
      const result = service.parse(
        'Jane Smith started following you',
        '',
        'noreply@linkedin.com',
      );
      expect(result.isLinkedIn).toBe(true);
      expect(result.type).toBe('follow');
      expect(result.engagerName).toBe('Jane Smith');
    });
  });

  describe('profile view parsing', () => {
    it('parses profile view notification', () => {
      const result = service.parse(
        'Alex Johnson viewed your profile',
        '',
        'noreply@e.linkedin.com',
      );
      expect(result.isLinkedIn).toBe(true);
      expect(result.type).toBe('profile_view');
      expect(result.engagerName).toBe('Alex Johnson');
    });
  });

  describe('connection parsing', () => {
    it('parses connection accepted notification', () => {
      const result = service.parse(
        'Chris Lee accepted your connection request',
        '',
        'noreply@linkedin.com',
      );
      expect(result.isLinkedIn).toBe(true);
      expect(result.type).toBe('connection');
      expect(result.engagerName).toBe('Chris Lee');
    });
  });

  describe('unknown LinkedIn email', () => {
    it('returns unknown type for unrecognized LinkedIn email', () => {
      const result = service.parse(
        'Your weekly LinkedIn digest',
        '',
        'noreply@linkedin.com',
      );
      expect(result.isLinkedIn).toBe(true);
      expect(result.type).toBe('unknown');
    });
  });
});
